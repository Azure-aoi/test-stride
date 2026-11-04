import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "stride-agent-test-"));
process.env.DB_PATH = path.join(tempDir, "agent.db");
process.env.SEED_DEMO = "true";

const store = await import("../src/agent-store.js");
const { db } = await import("../src/db.js");
const { buildAgentContext } = await import("../src/context-engine.js");
const { executeAgentTool } = await import("../src/agent-tools.js");
const { searchTrainingKnowledge } = await import("../src/knowledge-rag.js");
const { analyzeLocalIntent, nextLocalAction } = await import(
  "../src/local-planner.js"
);
const runtime = await import("../src/agent-runtime.js");

test("creates isolated sessions and stores messages", () => {
  const session = store.createSession("测试会话");
  store.saveSessionMessage({
    sessionId: session.id,
    role: "user",
    content: "这是测试问题"
  });
  const messages = store.listSessionMessages(session.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "这是测试问题");
  assert.equal(store.sessionMemoryStats(session.id).messageCount, 1);
});

test("stores structured profile and retrieves long-term memory", () => {
  const profile = store.saveRunnerProfile({
    displayName: "测试跑者",
    goalRace: "半程马拉松",
    injuryNotes: "右膝不适时停止质量课"
  });
  assert.equal(profile.goalRace, "半程马拉松");

  const memory = store.createMemory({
    type: "preference",
    content: "长距离训练安排在周六上午",
    importance: 0.9
  });
  const matches = store.searchMemories("长距离 周六");
  assert.ok(matches.some((item) => item.id === memory.id));
});

test("preserves zero importance for manual memories", () => {
  const memory = store.createMemory({
    type: "preference",
    content: "零重要性记忆测试",
    importance: 0
  });
  assert.equal(memory.importance, 0);
  const updated = store.updateMemory(memory.id, { importance: 0 });
  assert.equal(updated.importance, 0);
});

test("new conflicting weekday memories supersede old ones", () => {
  const oldMemory = store.createMemory({
    type: "preference",
    content: "周一我跑不了",
    importance: 0.8
  });
  const newMemory = store.createMemory({
    type: "preference",
    content: "周一现在可以跑",
    importance: 0.8
  });
  const active = store.listMemories(200);
  assert.ok(active.some((item) => item.id === newMemory.id));
  assert.ok(!active.some((item) => item.id === oldMemory.id));
});

test("weekday memories conflict only on the same structured attribute", () => {
  const sprint = store.createMemory({
    type: "preference",
    content: "周四喜欢冲刺跑",
    importance: 0.8
  });
  const outdoor = store.createMemory({
    type: "preference",
    content: "周四喜欢户外跑",
    importance: 0.8
  });
  let active = store.listMemories(200);
  assert.ok(active.some((item) => item.id === sprint.id));
  assert.ok(active.some((item) => item.id === outdoor.id));
  assert.ok(sprint.facets.some((facet) => facet.attribute === "session-type"));
  assert.ok(outdoor.facets.some((facet) => facet.attribute === "surface"));

  const indoor = store.createMemory({
    type: "preference",
    content: "周四改室内跑",
    importance: 0.8
  });
  active = store.listMemories(200);
  assert.ok(active.some((item) => item.id === sprint.id));
  assert.ok(!active.some((item) => item.id === outdoor.id));
  assert.ok(active.some((item) => item.id === indoor.id));

  const tempo = store.createMemory({
    type: "preference",
    content: "周四改成节奏跑",
    importance: 0.8
  });
  active = store.listMemories(200);
  assert.ok(!active.some((item) => item.id === sprint.id));
  assert.ok(active.some((item) => item.id === indoor.id));
  assert.ok(active.some((item) => item.id === tempo.id));
});

test("repairs legacy supersessions that are not conflicts under facet rules", () => {
  const availability = store.createMemory({
    type: "preference",
    content: "周五可以跑",
    importance: 0.8
  });
  const longPreference = store.createMemory({
    type: "preference",
    content: "周五喜欢跑长一些",
    importance: 0.8
  });
  assert.ok(
    longPreference.facets.some(
      (facet) =>
        facet.scope === "weekday:5" && facet.attribute === "session-type"
    )
  );
  db.prepare(
    `UPDATE memory_items
     SET superseded_at = ?, superseded_by = ?
     WHERE id = ?`
  ).run(new Date().toISOString(), longPreference.id, availability.id);
  const restored = store.repairInvalidSupersessions();
  const active = store.listMemories(200);
  assert.ok(restored >= 1);
  assert.ok(active.some((item) => item.id === availability.id));
  assert.ok(active.some((item) => item.id === longPreference.id));
});

test("invalid memory types fall back to a supported type", () => {
  const memory = store.createMemory({
    type: "unsupported",
    content: "无效类型回退测试"
  });
  assert.equal(memory.type, "preference");
});

test("builds context with profile, memories and recent activities", () => {
  const session = store.createSession("上下文测试");
  const context = buildAgentContext({
    sessionId: session.id,
    question: "周六长距离怎么安排？"
  });
  assert.equal(context.profile.goalRace, "半程马拉松");
  assert.ok(context.memories.some((item) => item.content.includes("长距离")));
  assert.ok(context.dashboard.current.runCount > 0);
  assert.equal(context.heartRateProfile.usage, "advisory-only");
  assert.match(context.systemPrompt, /heartRateProfile/);
  assert.match(context.systemPrompt, /不得使用心率选择模板/);
  assert.equal(context.usageEstimate.budget, 6000);
  assert.match(context.systemPrompt, /服务端本轮已经加载 \d+ 条训练记录/);
  assert.match(context.systemPrompt, /recentRuns/);
});

test("always includes saved long-term memories even without keyword overlap", () => {
  const memory = store.createMemory({
    type: "preference",
    content: "周一我跑不了",
    importance: 0.9
  });
  const session = store.createSession("全量记忆上下文测试");
  const context = buildAgentContext({
    sessionId: session.id,
    question: "给我接下来七天课表"
  });
  assert.ok(context.memories.some((item) => item.id === memory.id));
  assert.match(context.systemPrompt, /周一我跑不了/);
  assert.match(context.systemPrompt, /即使当前问题没有出现相同关键词/);
});

test("trims lower-priority context when the token budget is tight", () => {
  for (let index = 0; index < 30; index += 1) {
    store.createMemory({
      type: "preference",
      content: `预算测试${index}：` + "训练安排需要结合恢复、时间和场地条件。".repeat(5),
      importance: 0.5
    });
  }
  const session = store.createSession("上下文预算测试");
  const roomy = buildAgentContext({
    sessionId: session.id,
    question: "下周怎么安排训练",
    maxTokens: 6000
  });
  const tight = buildAgentContext({
    sessionId: session.id,
    question: "下周怎么安排训练",
    maxTokens: 3000
  });
  assert.ok(tight.memories.length < roomy.memories.length);
  assert.ok(
    tight.usageEstimate.total < roomy.usageEstimate.total ||
      tight.usageEstimate.budgetSatisfied
  );
});

test("keeps the current question out of the system prompt", () => {
  const session = store.createSession("去重测试");
  store.saveSessionMessage({
    sessionId: session.id,
    role: "user",
    content: "上一轮问题"
  });
  const context = buildAgentContext({
    sessionId: session.id,
    question: "这一轮的新问题"
  });
  assert.ok(
    context.modelMessages.every((message) => message.content !== "这一轮的新问题")
  );
  assert.ok(!context.systemPrompt.includes("这一轮的新问题"));
  assert.ok(!context.systemPrompt.includes('"recentMessages"'));
  assert.equal(
    context.usageEstimate.total,
    context.usageEstimate.system +
      context.usageEstimate.conversation +
      context.usageEstimate.question
  );
});

test("compresses old messages once and reuses the summary", () => {
  const session = store.createSession("摘要测试");
  for (let index = 0; index < 12; index += 1) {
    store.saveSessionMessage({
      sessionId: session.id,
      role: index % 2 ? "assistant" : "user",
      content: `消息${index} ` + "x".repeat(160)
    });
  }
  const first = buildAgentContext({
    sessionId: session.id,
    question: "继续",
    maxTokens: 400
  });
  assert.equal(first.compression.applied, true);
  const summaryAfterFirst = store.getSession(session.id).summary;
  assert.ok(summaryAfterFirst.length > 0);
  buildAgentContext({ sessionId: session.id, question: "继续", maxTokens: 400 });
  assert.equal(store.getSession(session.id).summary, summaryAfterFirst);
});

test("retrieves relevant local training knowledge", () => {
  const matches = searchTrainingKnowledge("恢复周如何降低训练负荷", 3);
  assert.ok(matches.length > 0);
  assert.ok(
    matches.some(
      (item) => item.content.includes("恢复") || item.content.includes("减量")
    )
  );
});

test("local planner branches dynamically from completed observations", () => {
  const intent = analyzeLocalIntent("同步高驰数据，并写入下周高驰训练计划");
  const completed = new Set();
  const tools = [];
  for (let index = 0; index < 8; index += 1) {
    const action = nextLocalAction({ intent, completed });
    if (action.type === "final") break;
    tools.push(action.tool);
    completed.add(action.tool);
  }
  assert.equal(tools[0], "syncActivitySource");
  assert.ok(tools.includes("getTrainingMetrics"));
  assert.ok(tools.includes("getTrainingCalendar"));
  assert.ok(tools.includes("previewPlanWrite"));
  assert.equal(intent.target, "coros");
});

test("recognizes less standard plan requests without treating questions as plans", () => {
  assert.equal(analyzeLocalIntent("给我编个七天练法").wantsPlan, true);
  assert.equal(analyzeLocalIntent("为半马准备一个基础训练周。").wantsPlan, true);
  assert.equal(analyzeLocalIntent("要不要安排恢复周？").wantsPlan, true);
  assert.equal(analyzeLocalIntent("下周怎么练？").wantsPlan, true);
  assert.equal(analyzeLocalIntent("什么是轻松跑").wantsPlan, false);
  assert.equal(analyzeLocalIntent("我的训练计划怎么样").wantsPlan, false);
  assert.equal(analyzeLocalIntent("帮我看看训练计划是否合理").wantsPlan, false);
});

test("executes local agent loop and records steps", async () => {
  const session = store.createSession("Agent Loop 测试");
  const started = runtime.startAgentRun({
    sessionId: session.id,
    question: "给我接下来一周训练计划",
    config: {
      provider: "local",
      apiStyle: "chat-completions",
      baseUrl: "",
      model: "",
      fallbackModel: "",
      apiKey: "",
      label: "本地分析"
    }
  });
  let run;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    run = runtime.getRunDetails(started.runId);
    if (["completed", "failed"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(run.status, "completed");
  assert.ok(run.answer.includes("下周安排"));
  assert.ok(run.steps.some((step) => step.toolName === "getTrainingMetrics"));
  assert.ok(run.steps.some((step) => step.toolName === "previewPlanWrite"));
});

test("local plan honors manually added weekday memory", async () => {
  store.createMemory({
    type: "preference",
    content: "周一没空",
    importance: 0.9
  });
  const session = store.createSession("记忆计划测试");
  const started = runtime.startAgentRun({
    sessionId: session.id,
    question: "给我接下来一周训练计划",
    config: {
      provider: "local",
      apiStyle: "chat-completions",
      baseUrl: "",
      model: "",
      fallbackModel: "",
      apiKey: "",
      label: "本地分析"
    }
  });
  let run;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    run = runtime.getRunDetails(started.runId);
    if (["completed", "failed"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(run.status, "completed");
  assert.match(run.answer, /不可训练日：周一/);
  const previewStep = run.steps.find(
    (step) => step.toolName === "previewPlanWrite"
  );
  assert.ok(previewStep);
  const monday = previewStep.output.plan.days.find(
    (day) => new Date(`${day.date}T12:00:00`).getDay() === 1
  );
  assert.equal(monday.training, "休息");
});

async function startMockModel(responses) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      requests.push({ url: request.url, body: data ? JSON.parse(data) : {} });
      const item = responses[requests.length - 1] || responses.at(-1);
      response.writeHead(item?.status || 200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(item?.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function chatCompletion(content) {
  return {
    id: `chatcmpl-${Math.random()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ]
  };
}

async function waitForRun(runId) {
  let run;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    run = runtime.getRunDetails(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return run;
}

function captureRunEvents(runId, lastEventId = null) {
  const chunks = [];
  let ended = false;
  const response = {
    req: {
      headers: lastEventId
        ? { "last-event-id": String(lastEventId) }
        : {}
    },
    writeHead() {},
    flushHeaders() {},
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    end() {
      ended = true;
    },
    on() {},
    destroyed: false,
    writableEnded: false
  };
  const accepted = runtime.subscribeRun(runId, response);
  const text = chunks.join("");
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) =>
    Number(match[1])
  );
  return { accepted, ended, text, ids };
}

test("uses native tool calling for external models", async () => {
  const memory = store.createMemory({
    type: "preference",
    content: "周二晚上加班，不安排强度课",
    importance: 0.9
  });
  const server = await startMockModel([
    { body: chatCompletion("来自原生工具协议的最终回答") }
  ]);
  try {
    const session = store.createSession("原生工具测试");
    const started = runtime.startAgentRun({
      sessionId: session.id,
      question: "最近训练怎么样？",
      config: {
        provider: "openai",
        apiStyle: "chat-completions",
        baseUrl: server.baseUrl,
        model: "test-model",
        fallbackModel: "",
        planningModel: "",
        apiKey: "test-key",
        label: "测试模型"
      }
    });
    const run = await waitForRun(started.runId);
    assert.equal(run.status, "completed");
    assert.match(run.answer, /原生工具协议/);
    assert.ok(server.requests.some((request) => Array.isArray(request.body.tools)));
    const decision = run.steps.find((step) => step.type === "decision");
    assert.equal(decision.output.protocol, "native-tools");
    const systemMessage = server.requests[0].body.messages.find(
      (message) => message.role === "system"
    );
    assert.match(systemMessage.content, new RegExp(memory.content));
    assert.match(systemMessage.content, /不得使用心率选择模板/);
  } finally {
    await server.close();
  }
});

test("replays only SSE events after Last-Event-ID", async () => {
  const session = store.createSession("SSE 续传测试");
  const started = runtime.startAgentRun({
    sessionId: session.id,
    question: "最近训练怎么样？",
    config: {
      provider: "local",
      apiStyle: "chat-completions",
      baseUrl: "",
      model: "",
      fallbackModel: "",
      apiKey: "",
      label: "本地分析"
    }
  });
  await waitForRun(started.runId);
  const first = captureRunEvents(started.runId);
  assert.equal(first.accepted, true);
  assert.equal(first.ended, true);
  assert.ok(first.ids.length >= 2);
  const second = captureRunEvents(started.runId, first.ids[0]);
  assert.equal(second.accepted, true);
  assert.ok(second.ids.every((id) => id > first.ids[0]));
});

test("forces a deterministic plan preview when the model skips plan tools", async () => {
  const server = await startMockModel([
    { body: chatCompletion("模型直接给出了一份未经计划工具校验的安排") },
    { body: chatCompletion("模型直接给出了一份未经计划工具校验的安排") },
    { body: chatCompletion("[]") }
  ]);
  try {
    const session = store.createSession("强制计划预览测试");
    const started = runtime.startAgentRun({
      sessionId: session.id,
      question: "给我接下来一周训练计划",
      config: {
        provider: "openai",
        apiStyle: "chat-completions",
        baseUrl: server.baseUrl,
        model: "test-model",
        fallbackModel: "",
        planningModel: "",
        apiKey: "test-key",
        label: "测试模型"
      }
    });
    const run = await waitForRun(started.runId);
    assert.equal(run.status, "completed");
    assert.ok(
      run.steps.some((step) => step.toolName === "previewPlanWrite")
    );
    assert.match(run.answer, /系统已自动使用确定性训练规则补齐/);
    assert.match(run.answer, /两周|下周安排|稳态|基础/);
  } finally {
    await server.close();
  }
});

test("downgrades to the JSON tool protocol when tools are unsupported", async () => {
  const server = await startMockModel([
    {
      status: 400,
      body: {
        error: {
          message: "tools are not supported by this model",
          type: "invalid_request_error"
        }
      }
    },
    {
      body: chatCompletion(
        JSON.stringify({ type: "final", content: "降级后的最终回答" })
      )
    },
    { body: chatCompletion("降级后的最终回答") }
  ]);
  try {
    const session = store.createSession("工具降级测试");
    const started = runtime.startAgentRun({
      sessionId: session.id,
      question: "最近训练怎么样？",
      config: {
        provider: "openai",
        apiStyle: "chat-completions",
        baseUrl: server.baseUrl,
        model: "test-model",
        fallbackModel: "",
        planningModel: "",
        apiKey: "test-key",
        label: "测试模型"
      }
    });
    const run = await waitForRun(started.runId);
    assert.equal(run.status, "completed");
    assert.match(run.answer, /降级后的最终回答/);
    assert.ok(
      run.steps.some(
        (step) => step.type === "decision" && step.output.decision === "final"
      )
    );
  } finally {
    await server.close();
  }
});

test("uses local fallback when external model returns no usable content", async () => {
  const session = store.createSession("模型保底测试");
  const started = runtime.startAgentRun({
    sessionId: session.id,
    question: "最近训练怎么样？",
    config: {
      provider: "openai",
      apiStyle: "chat-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      model: "test-model",
      fallbackModel: "",
      planningModel: "",
      apiKey: "test-key",
      label: "测试模型"
    }
  });
  let run;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    run = runtime.getRunDetails(started.runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(run.status, "completed");
  assert.equal(run.usage.fallback, true);
  assert.match(run.answer, /本地训练分析/);
  assert.match(run.context.systemPrompt, /当前训练事实|服务端本轮已经加载/);
  assert.ok(run.steps.some((step) => step.type === "fallback"));
});

test("requires confirmation before publishing a plan", async () => {
  const preview = await executeAgentTool(
    "previewPlanWrite",
    { target: "local" },
    { runId: "test-run" }
  );
  assert.ok(preview.confirmationToken);
  assert.equal(preview.sessions.length, 7);
  await assert.rejects(
    executeAgentTool(
      "publishPlan",
      { confirmationToken: "invalid-token" },
      { runId: "test-run" }
    ),
    /确认令牌/
  );
  const published = await executeAgentTool(
    "publishPlan",
    { confirmationToken: preview.confirmationToken },
    { runId: "test-run" }
  );
  assert.equal(published.published, 7);
});

test("retry does not duplicate the user message", async () => {
  const session = store.createSession("重试测试");
  const config = {
    provider: "local",
    apiStyle: "chat-completions",
    baseUrl: "",
    model: "",
    fallbackModel: "",
    apiKey: "",
    label: "本地分析"
  };
  const first = runtime.startAgentRun({
    sessionId: session.id,
    question: "最近训练怎么样？",
    config
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = runtime.getRunDetails(first.runId);
    if (["completed", "failed"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const before = store
    .listSessionMessages(session.id)
    .filter((message) => message.role === "user").length;
  const second = runtime.startAgentRun({
    sessionId: session.id,
    question: "最近训练怎么样？",
    config,
    recordQuestion: false
  });
  const after = store
    .listSessionMessages(session.id)
    .filter((message) => message.role === "user").length;
  assert.equal(after, before);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = runtime.getRunDetails(second.runId);
    if (["completed", "failed"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("marks interrupted runs as failed on startup", () => {
  const session = store.createSession("中断测试");
  store.createAgentRun({
    id: "interrupted-run",
    sessionId: session.id,
    question: "被中断的问题",
    modelLabel: "测试模型",
    model: {},
    promptVersion: null,
    context: {}
  });
  assert.equal(store.getAgentRun("interrupted-run").status, "queued");
  const changed = store.failInterruptedRuns();
  assert.ok(changed >= 1);
  assert.equal(store.getAgentRun("interrupted-run").status, "failed");
});

test("prunes audit runs and steps past the retention window", () => {
  const session = store.createSession("清理测试");
  for (const id of ["old-run", "fresh-run"]) {
    store.createAgentRun({
      id,
      sessionId: session.id,
      question: `问题 ${id}`,
      modelLabel: "测试模型",
      model: {},
      promptVersion: null,
      context: {}
    });
    store.addAgentStep({ runId: id, stepNo: 1, type: "tool" });
  }
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE agent_runs SET started_at = ? WHERE id = ?").run(old, "old-run");

  const result = store.pruneAgentAudit({ days: 90 });
  assert.equal(result.runs, 1);
  assert.equal(result.steps, 1);
  assert.equal(store.getAgentRun("old-run"), null);
  assert.ok(store.getAgentRun("fresh-run"));
  assert.equal(store.listAgentSteps("old-run").length, 0);
  assert.equal(store.listAgentSteps("fresh-run").length, 1);
});

test("regenerating a plan preserves completed sessions and RPE", async () => {
  const startDate = "2027-01-04";
  const preview = await executeAgentTool(
    "previewPlanWrite",
    { target: "local", startDate },
    { runId: "preserve-run" }
  );
  const published = await executeAgentTool(
    "publishPlan",
    { confirmationToken: preview.confirmationToken },
    { runId: "preserve-run" }
  );
  const target = published.sessions[0];
  store.checkInTrainingSession(target.id, {
    status: "completed",
    rpe: 7,
    notes: "完成"
  });
  const nextPreview = await executeAgentTool(
    "previewPlanWrite",
    { target: "local", startDate },
    { runId: "preserve-run" }
  );
  await executeAgentTool(
    "publishPlan",
    { confirmationToken: nextPreview.confirmationToken },
    { runId: "preserve-run" }
  );
  const preserved = store
    .listTrainingSessions({ start: startDate, end: "2027-01-10" })
    .filter((item) => item.date === target.date);
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].status, "completed");
  assert.equal(preserved[0].rpe, 7);
});
