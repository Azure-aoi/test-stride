import { readFile } from "node:fs/promises";
import { analyzeLocalIntent } from "../src/local-planner.js";

const baseUrl =
  process.env.BASE_URL || `http://localhost:${process.env.PORT || 4173}`;
const externalModelKey = process.env.EVAL_MODEL_API_KEY || "";
const modelConfig = externalModelKey
  ? {
      provider: process.env.EVAL_MODEL_PROVIDER || "openai-compatible",
      apiStyle: process.env.EVAL_MODEL_API_STYLE || "chat-completions",
      baseUrl: process.env.EVAL_MODEL_BASE_URL || "",
      model: process.env.EVAL_MODEL_NAME || "",
      fallbackModel: process.env.EVAL_MODEL_FALLBACK || "",
      planningModel: process.env.EVAL_MODEL_PLANNING || "",
      apiKey: externalModelKey,
      label: process.env.EVAL_MODEL_LABEL || "Agent 评估模型"
    }
  : {
      provider: "local",
      apiStyle: "chat-completions",
      baseUrl: "",
      model: "",
      fallbackModel: "",
      planningModel: "",
      apiKey: "",
      label: "本地分析"
    };
const cases = JSON.parse(
  await readFile(new URL("../data/agent-eval-cases.json", import.meta.url), "utf8")
);

async function createSession(title) {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title })
  });
  if (!response.ok) throw new Error("无法创建评估会话");
  const payload = await response.json();
  return payload.session.id;
}

async function deleteSession(sessionId) {
  await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE"
  }).catch(() => {});
}

const results = [];
const dashboardResponse = await fetch(`${baseUrl}/api/dashboard?days=28`);
const dashboard = await dashboardResponse.json();
const hasTrainingData = Boolean(dashboard.data?.hasRealData);
for (const item of cases) {
  const sessionId = await createSession(`__eval_${item.id}_${Date.now()}`);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/api/agent/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        question: item.question,
        model: modelConfig
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      results.push({ id: item.id, pass: false, error: payload.error?.message });
      continue;
    }
    let run;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const runResponse = await fetch(
        `${baseUrl}/api/agent/runs/${encodeURIComponent(payload.runId)}`
      );
      const runPayload = await runResponse.json();
      run = runPayload.run;
      if (["completed", "failed", "cancelled"].includes(run?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const answer = run?.answer || "";
    const steps = run?.steps || [];
    const toolNames = steps
      .filter((step) => step.type === "tool")
      .map((step) => step.toolName);
    const failures = [];
    if (run?.status !== "completed") failures.push(`status=${run?.status || "missing"}`);
    if (!item.expectedAny.some((keyword) => answer.includes(keyword))) {
      failures.push(`missing-keyword:${item.expectedAny.join("|")}`);
    }
    if (answer.length < 80) failures.push("answer-too-short");
    if (hasTrainingData && /没有训练数据|找不到训练记录|暂无训练数据/.test(answer)) {
      failures.push("false-no-data-claim");
    }
    if (!toolNames.includes("getTrainingMetrics")) {
      failures.push("missing-tool:getTrainingMetrics");
    }
    if (item.requiresPreview) {
      if (!analyzeLocalIntent(item.question).wantsPlan) {
        failures.push("plan-intent-not-detected");
      }
      const previewStep = steps.find(
        (step) => step.type === "tool" && step.toolName === "previewPlanWrite"
      );
      if (!previewStep) {
        failures.push("missing-tool:previewPlanWrite");
      } else {
        const planSessions = previewStep.output?.sessions || [];
        const dates = new Set(planSessions.map((session) => session.date));
        if (planSessions.length !== 7) failures.push("plan-not-seven-days");
        if (dates.size !== planSessions.length) {
          failures.push("plan-duplicate-dates");
        }
      }
    }
    const durationMs = Date.now() - startedAt;
    if (durationMs > (externalModelKey ? 120_000 : 15_000)) {
      failures.push(
        externalModelKey ? "duration-over-120s" : "duration-over-15s"
      );
    }
    const pass = failures.length === 0;
    results.push({
      id: item.id,
      pass,
      durationMs,
      status: run?.status || "missing",
      tools: toolNames,
      failures
    });
  } finally {
    await deleteSession(sessionId);
  }
}

const passed = results.filter((item) => item.pass).length;
const score = results.length ? passed / results.length : 0;
console.log(
  JSON.stringify(
    {
      total: results.length,
      passed,
      failed: results.length - passed,
      score: Number((score * 100).toFixed(1)),
      modelMode: externalModelKey ? "external" : "local",
      results
    },
    null,
    2
  )
);
if (score < 0.8) process.exitCode = 1;
