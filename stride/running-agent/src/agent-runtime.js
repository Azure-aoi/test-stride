import { randomUUID } from "node:crypto";
import {
  addAgentStep,
  createAgentRun,
  estimateTokens,
  getAgentRun,
  getSession,
  listAgentSteps,
  savePromptVersion,
  saveSessionMessage,
  updateAgentRun
} from "./agent-store.js";
import { buildAgentContext } from "./context-engine.js";
import { buildPlanConstraints } from "./plan-constraints.js";
import {
  describeToolsForPrompt,
  executeAgentTool,
  getToolDefinitions
} from "./agent-tools.js";
import {
  generateAgentDecision,
  generateNativeAgentDecision,
  reflectAgentAnswer
} from "./model-gateway.js";
import { localCoachAnalysis } from "./coach.js";
import { extractAndSaveMemories } from "./memory-extraction.js";
import {
  analyzeLocalIntent,
  nextLocalAction
} from "./local-planner.js";

const MAX_STEPS = 8;
const MEMORY_STEP_NO = MAX_STEPS + 5;
const MODEL_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 120_000;
const channels = new Map();
const controllers = new Map();

function publicModel(config) {
  return {
    provider: config.provider,
    apiStyle: config.apiStyle,
    baseUrl: config.baseUrl,
    model: config.model,
    fallbackModel: config.fallbackModel,
    planningModel: config.planningModel,
    label: config.label
  };
}

function modelLabel(config) {
  return config.provider === "local"
    ? "本地分析"
    : `${config.label || config.provider} · ${config.model || "未命名模型"}`;
}

function createChannel(runId) {
  const channel = {
    history: [],
    listeners: new Set(),
    terminal: false
  };
  channels.set(runId, channel);
  return channel;
}

function writeEvent(response, event, data, id = null) {
  if (id !== null) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function safeWrite(response, event, data, id = null) {
  if (!response || response.writableEnded || response.destroyed) return false;
  try {
    writeEvent(response, event, data, id);
    return true;
  } catch {
    return false;
  }
}

function emit(runId, event, data) {
  const channel = channels.get(runId);
  if (!channel || channel.terminal) return;
  const id = channel.history.length + 1;
  const payload = { ...data, at: new Date().toISOString(), sequence: id };
  channel.history.push({ id, event, data: payload });
  for (const response of [...channel.listeners]) {
    if (!safeWrite(response, event, payload, id)) {
      channel.listeners.delete(response);
    }
  }
  if (event === "run.completed" || event === "run.failed" || event === "run.cancelled") {
    channel.terminal = true;
    for (const response of [...channel.listeners]) {
      try {
        response.end();
      } catch {
        // The client may already be gone.
      }
    }
    channel.listeners.clear();
    setTimeout(() => channels.delete(runId), 10 * 60 * 1000).unref();
  }
}

function stage(runId, value) {
  updateAgentRun(runId, { status: value, stage: value });
  emit(runId, "stage.changed", { runId, stage: value });
}

function parseDecision(text) {
  const source = String(text || "").trim();
  const unfenced = source
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const candidates = [unfenced];
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && ["tool", "final"].includes(parsed.type)) return parsed;
    } catch {
      // Some compatible models wrap JSON in prose.
    }
  }
  return { type: "final", content: source };
}

function protocolPrompt() {
  return [
    "你正在一个受控 Agent Loop 中运行。",
    "每一步只能输出一个 JSON 对象，不要输出代码围栏或额外说明。",
    "调用工具时输出：",
    '{"type":"tool","tool":"getTrainingMetrics","arguments":{"days":28},"summary":"读取近期训练指标"}',
    "完成任务时输出：",
    '{"type":"final","content":"给用户的完整中文回答"}',
    `一次只调用一个工具。最多执行 ${MAX_STEPS} 步。`,
    "可用工具：",
    describeToolsForPrompt()
  ].join("\n\n");
}

function observationContent(toolName, output) {
  return [
    `工具 ${toolName} 的执行结果如下。`,
    JSON.stringify(output, null, 2),
    "请基于事实继续选择下一个工具或输出最终回答。"
  ].join("\n\n");
}

function compactOutput(output, maxLength = 20_000) {
  const text = JSON.stringify(output);
  if (text.length <= maxLength) return output;
  return {
    truncated: true,
    preview: text.slice(0, maxLength),
    note: "工具结果过长，已截断"
  };
}

function modelVisibleOutput(toolName, output) {
  if (toolName !== "previewPlanWrite" || !output || typeof output !== "object") {
    return output;
  }
  const { confirmationToken, ...rest } = output;
  return rest;
}

export function buildFallbackAnswer({ built, question, reason }) {
  const planMemories = built.planMemories || built.memories || [];
  const constraints = buildPlanConstraints({
    profile: built.profile,
    memories: planMemories
  });
  const local = localCoachAnalysis({
    dashboard: built.dashboard,
    activities: built.activities,
    question,
    analysisNote: built.analysisWindow?.isHistorical
      ? `数据说明：最近 28 天没有训练记录，本次基于截至 ${built.analysisWindow.latest.toLocaleDateString("zh-CN")} 的历史数据。`
      : null,
    profile: built.profile,
    heartRateProfile: built.heartRateProfile,
    memories: planMemories,
    knowledge: built.knowledge,
    trainingCalendar: built.trainingCalendar,
    constraints
  });
  return [
    "模型未返回可用文本，已自动切换到本地训练分析。",
    `原因：${reason || "模型空响应或接口异常"}`,
    "",
    local
  ].join("\n");
}

function completeRun({
  runId,
  built,
  question,
  config,
  startedAt,
  answer,
  observations = [],
  fallback = false,
  fallbackReason = null
}) {
  const finalAnswer = answer.trim();
  const finalModelLabel = fallback ? "本地保底" : modelLabel(config);
  saveSessionMessage({
    sessionId: built.session.id,
    role: "assistant",
    content: finalAnswer,
    modelLabel: finalModelLabel,
    runId
  });
  const usage = {
    estimatedInputTokens: built.usageEstimate,
    estimatedOutputTokens: estimateTokens(finalAnswer),
    estimatedTotalTokens:
      (built.usageEstimate.total || 0) + estimateTokens(finalAnswer),
    cost: null,
    durationMs: Date.now() - startedAt,
    fallback,
    fallbackReason
  };
  updateAgentRun(runId, {
    status: "completed",
    stage: "completed",
    answer: finalAnswer,
    usage,
    endedAt: new Date().toISOString()
  });
  addAgentStep({
    runId,
    stepNo: fallback ? MAX_STEPS + 30 : MAX_STEPS + 10,
    type: fallback ? "fallback" : "final",
    input: { question },
    output: { answer: finalAnswer, fallbackReason },
    status: "completed",
    durationMs: Date.now() - startedAt
  });
  emit(runId, "message.delta", {
    runId,
    content: finalAnswer,
    model: finalModelLabel,
    fallback
  });
  emit(runId, "run.completed", {
    runId,
    answer: finalAnswer,
    model: finalModelLabel,
    usage,
    fallback,
    fallbackReason,
    observationCount: observations.length
  });
}

async function runLocalAgent({
  runId,
  built,
  question,
  config,
  signal
}) {
  void config;
  const intent = analyzeLocalIntent(question);
  const completed = new Set();
  const observations = [];
  let stepNo = 0;
  while (stepNo < MAX_STEPS) {
    if (signal?.aborted) {
      const cancelled = new Error("Agent 运行已取消");
      cancelled.code = "RUN_CANCELLED";
      throw cancelled;
    }
    stage(runId, "planning");
    const action = nextLocalAction({ intent, completed });
    if (action.type === "final") break;
    stepNo += 1;
    completed.add(action.tool);
    addAgentStep({
      runId,
      stepNo,
      type: "decision",
      input: { question, intent },
      output: {
        planner: "local-rules",
        tool: action.tool,
        arguments: action.arguments,
        summary: action.summary
      }
    });
    stage(runId, "acting");
    emit(runId, "tool.started", {
      runId,
      stepNo,
      toolName: action.tool,
      inputSummary: action.summary
    });
    const startedAt = Date.now();
    try {
      const output = await executeAgentTool(action.tool, action.arguments, {
        runId,
        sessionId: built.session.id,
        signal
      });
      observations.push({ tool: action.tool, output });
      addAgentStep({
        runId,
        stepNo,
        type: "tool",
        toolName: action.tool,
        input: action.arguments,
        output,
        durationMs: Date.now() - startedAt
      });
      emit(runId, "tool.completed", {
        runId,
        stepNo,
        toolName: action.tool,
        output: compactOutput(output),
        outputSummary: action.summary
      });
      stage(runId, "observing");
    } catch (error) {
      if (error.code === "RUN_CANCELLED") throw error;
      addAgentStep({
        runId,
        stepNo,
        type: "tool",
        toolName: action.tool,
        input: action.arguments,
        output: { error: error.message },
        status: "failed",
        durationMs: Date.now() - startedAt
      });
      emit(runId, "tool.completed", {
        runId,
        stepNo,
        toolName: action.tool,
        output: { error: error.message },
        status: "failed",
        outputSummary: error.message
      });
      break;
    }
  }

  stage(runId, "reflecting");
  const outputFor = (tool) =>
    observations.find((item) => item.tool === tool)?.output;
  const profile = outputFor("getRunnerProfile")?.profile || built.profile;
  const memories =
    outputFor("searchMemories")?.memories ||
    built.planMemories ||
    built.memories ||
    [];
  const knowledge =
    outputFor("searchTrainingKnowledge")?.knowledge || built.knowledge || [];
  const trainingCalendar =
    outputFor("getTrainingCalendar")?.sessions || built.trainingCalendar || [];
  const preview = outputFor("previewPlanWrite");
  const constraints =
    preview?.constraints ||
    buildPlanConstraints({
      profile,
      memories: built.planMemories || memories
    });
  let content = localCoachAnalysis({
    dashboard: built.dashboard,
    activities: built.activities,
    question,
    analysisNote: built.analysisWindow.isHistorical
      ? `数据说明：最近 28 天没有训练记录，本次基于截至 ${built.analysisWindow.latest.toLocaleDateString("zh-CN")} 的历史数据。`
      : null,
    profile,
    heartRateProfile: built.heartRateProfile,
    memories,
    knowledge,
    trainingCalendar,
    constraints,
    plan: preview?.plan || null
  });
  if (preview?.hasConflicts) {
    content += `\n\n日历提示：预览中有 ${preview.conflicts?.length || 0} 天已存在课程，写入时请重点核对。`;
  }
  stage(runId, "observing");
  return { content, observations };
}

async function runJsonExternalAgent({
  runId,
  built,
  question,
  config,
  signal
}) {
  const planningConfig = {
    ...config,
    model: config.planningModel || config.model
  };
  const system = `${built.systemPrompt}\n\n${protocolPrompt()}`;
  const messages = [
    ...built.modelMessages,
    { role: "user", content: question }
  ];
  const observations = [];
  let stepNo = 0;
  let toolFailures = 0;
  let finalContent = "";

  while (stepNo < MAX_STEPS) {
    if (signal.aborted) {
      const cancelled = new Error("Agent 运行已取消");
      cancelled.code = "RUN_CANCELLED";
      throw cancelled;
    }
    stepNo += 1;
    stage(runId, "planning");
    const decisionStartedAt = Date.now();
    const decisionResult = await generateAgentDecision({
      config: planningConfig,
      system,
      messages,
      signal
    });
    const decision = parseDecision(decisionResult.content);
    addAgentStep({
      runId,
      stepNo,
      type: "decision",
      input: { question },
      output: {
        decision: decision.type,
        tool: decision.tool || null,
        summary: decision.summary || null,
        model: decisionResult.model,
        fallback: decisionResult.fallback,
        attempts: decisionResult.attempts
      },
      durationMs: Date.now() - decisionStartedAt
    });

    if (decision.type === "final") {
      finalContent = String(decision.content || "").trim();
      break;
    }

    if (!decision.tool) {
      toolFailures += 1;
      messages.push({
        role: "assistant",
        content: JSON.stringify(decision)
      });
      messages.push({
        role: "user",
        content: "工具调用缺少 tool 字段。请重新输出合法 JSON。"
      });
      if (toolFailures >= 2) throw new Error("模型连续返回无效工具调用");
      continue;
    }

    stage(runId, "acting");
    emit(runId, "tool.started", {
      runId,
      stepNo,
      toolName: decision.tool,
      inputSummary: decision.summary || decision.tool
    });
    const startedAt = Date.now();
    let output;
    try {
      output = await executeAgentTool(decision.tool, decision.arguments || {}, {
        runId,
        sessionId: built.session.id,
        signal
      });
      if (signal.aborted) {
        const cancelled = new Error("Agent 运行已取消");
        cancelled.code = "RUN_CANCELLED";
        throw cancelled;
      }
      toolFailures = 0;
      emit(runId, "tool.completed", {
        runId,
        stepNo,
        toolName: decision.tool,
        output: compactOutput(output),
        outputSummary: decision.summary || `${decision.tool} 已完成`
      });
    } catch (error) {
      if (error.code === "RUN_CANCELLED") throw error;
      toolFailures += 1;
      output = { error: error.message };
      emit(runId, "tool.completed", {
        runId,
        stepNo,
        toolName: decision.tool,
        output,
        status: "failed",
        outputSummary: error.message
      });
      if (toolFailures >= 2) throw new Error(`工具连续失败：${error.message}`);
    }
    addAgentStep({
      runId,
      stepNo,
      type: "tool",
      toolName: decision.tool,
      input: decision.arguments || {},
      output,
      status: output?.error ? "failed" : "completed",
      durationMs: Date.now() - startedAt
    });
    const visibleOutput = modelVisibleOutput(decision.tool, output);
    observations.push({ tool: decision.tool, output: visibleOutput });
    messages.push({
      role: "assistant",
      content: JSON.stringify(decision)
    });
    messages.push({
      role: "user",
      content: observationContent(
        decision.tool,
        compactOutput(visibleOutput)
      )
    });
    stage(runId, "observing");
  }

  if (!finalContent) {
    throw new Error("Agent 达到最大步骤，未能生成最终回答");
  }

  finalContent = await reflectFinalAnswer({
    runId,
    built,
    question,
    config: planningConfig,
    answer: finalContent,
    observations,
    stepNo: stepNo + 1,
    signal
  });
  return { content: finalContent, observations, stepNo };
}

async function reflectFinalAnswer({
  runId,
  built,
  question,
  config,
  answer,
  observations,
  stepNo,
  signal
}) {
  stage(runId, "reflecting");
  try {
    const reflected = await reflectAgentAnswer({
      config,
      system: built.systemPrompt,
      question,
      answer,
      observations,
      signal
    });
    return reflected || answer;
  } catch (error) {
    if (error.code === "RUN_CANCELLED") throw error;
    addAgentStep({
      runId,
      stepNo,
      type: "reflection",
      input: { question },
      output: { skipped: true, reason: error.message },
      status: "failed"
    });
    return answer;
  }
}

async function runNativeExternalAgent({
  runId,
  built,
  question,
  config,
  signal
}) {
  const planningConfig = {
    ...config,
    model: config.planningModel || config.model
  };
  const messages = [
    ...built.modelMessages,
    { role: "user", content: question }
  ];
  const tools = getToolDefinitions();
  const observations = [];
  let stepNo = 0;
  let toolFailures = 0;
  let usedTools = false;
  let finalContent = "";

  while (stepNo < MAX_STEPS) {
    if (signal.aborted) {
      const cancelled = new Error("Agent 运行已取消");
      cancelled.code = "RUN_CANCELLED";
      throw cancelled;
    }
    stage(runId, "planning");
    const decisionStartedAt = Date.now();
    let decisionResult;
    try {
      decisionResult = await generateNativeAgentDecision({
        config: planningConfig,
        system: built.systemPrompt,
        messages,
        tools,
        signal
      });
    } catch (error) {
      if (error.code === "MODEL_TOOLS_UNSUPPORTED") {
        error.safeToRetry = !usedTools;
      }
      throw error;
    }
    stepNo += 1;
    const decision = decisionResult;
    addAgentStep({
      runId,
      stepNo,
      type: "decision",
      input: { question },
      output: {
        decision: decision.toolCalls.length ? "tool" : "final",
        tools: decision.toolCalls.map((call) => call.name),
        model: decision.model,
        fallback: decision.fallback,
        attempts: decision.attempts,
        protocol: "native-tools"
      },
      durationMs: Date.now() - decisionStartedAt
    });

    if (!decision.toolCalls.length) {
      finalContent = String(decision.content || "").trim();
      break;
    }
    if (!decision.assistantMessage) {
      throw new Error("模型返回了无效的原生工具调用");
    }
    messages.push(decision.assistantMessage);
    for (let index = 0; index < decision.toolCalls.length; index += 1) {
      const call = decision.toolCalls[index];
      if (index > 0) stepNo += 1;
      if (stepNo > MAX_STEPS) {
        throw new Error("Agent 达到最大步骤，未能生成最终回答");
      }
      usedTools = true;
      stage(runId, "acting");
      emit(runId, "tool.started", {
        runId,
        stepNo,
        toolName: call.name,
        inputSummary: call.name
      });
      const startedAt = Date.now();
      let output;
      try {
        output = await executeAgentTool(call.name, call.arguments || {}, {
          runId,
          sessionId: built.session.id,
          signal
        });
        if (signal.aborted) {
          const cancelled = new Error("Agent 运行已取消");
          cancelled.code = "RUN_CANCELLED";
          throw cancelled;
        }
        toolFailures = 0;
        emit(runId, "tool.completed", {
          runId,
          stepNo,
          toolName: call.name,
          output: compactOutput(output),
          outputSummary: `${call.name} 已完成`
        });
      } catch (error) {
        if (error.code === "RUN_CANCELLED") throw error;
        toolFailures += 1;
        output = { error: error.message };
        emit(runId, "tool.completed", {
          runId,
          stepNo,
          toolName: call.name,
          output,
          status: "failed",
          outputSummary: error.message
        });
        if (toolFailures >= 2) {
          throw new Error(`工具连续失败：${error.message}`);
        }
      }
      addAgentStep({
        runId,
        stepNo,
        type: "tool",
        toolName: call.name,
        input: call.arguments || {},
        output,
        status: output?.error ? "failed" : "completed",
        durationMs: Date.now() - startedAt
      });
      const visibleOutput = modelVisibleOutput(call.name, output);
      observations.push({ tool: call.name, output: visibleOutput });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: observationContent(
          call.name,
          compactOutput(visibleOutput)
        )
      });
      stage(runId, "observing");
    }
  }

  if (!finalContent) {
    throw new Error("Agent 达到最大步骤，未能生成最终回答");
  }

  finalContent = await reflectFinalAnswer({
    runId,
    built,
    question,
    config: planningConfig,
    answer: finalContent,
    observations,
    stepNo: stepNo + 1,
    signal
  });
  return { content: finalContent, observations, stepNo };
}

async function enforcePlanPreview({ runId, built, question, signal, result }) {
  const intent = analyzeLocalIntent(question);
  const existing = result.observations.find(
    (item) => item.tool === "previewPlanWrite"
  );
  if (!intent.wantsPlan || existing) return result;

  const stepNo = result.stepNo + 1;
  const argumentsValue = {
    startDate: intent.startDate,
    target: intent.target
  };
  stage(runId, "acting");
  emit(runId, "tool.started", {
    runId,
    stepNo,
    toolName: "previewPlanWrite",
    inputSummary: "按确定性训练规则生成计划预览"
  });
  const startedAt = Date.now();
  const output = await executeAgentTool("previewPlanWrite", argumentsValue, {
    runId,
    sessionId: built.session.id,
    signal
  });
  if (signal.aborted) {
    const cancelled = new Error("Agent 运行已取消");
    cancelled.code = "RUN_CANCELLED";
    throw cancelled;
  }
  addAgentStep({
    runId,
    stepNo,
    type: "tool",
    toolName: "previewPlanWrite",
    input: argumentsValue,
    output,
    status: "completed",
    durationMs: Date.now() - startedAt
  });
  emit(runId, "tool.completed", {
    runId,
    stepNo,
    toolName: "previewPlanWrite",
    output: compactOutput(output),
    outputSummary: "确定性计划预览已生成"
  });
  stage(runId, "observing");

  const visibleOutput = modelVisibleOutput("previewPlanWrite", output);
  const memories = built.planMemories || built.memories || [];
  const content = localCoachAnalysis({
    dashboard: built.dashboard,
    activities: built.activities,
    question,
    analysisNote: built.analysisWindow?.isHistorical
      ? `数据说明：最近 28 天没有训练记录，本次基于截至 ${built.analysisWindow.latest.toLocaleDateString("zh-CN")} 的历史数据。`
      : null,
    profile: built.profile,
    heartRateProfile: built.heartRateProfile,
    memories,
    knowledge: built.knowledge,
    trainingCalendar: built.trainingCalendar,
    constraints: output.constraints,
    plan: output.plan
  });
  return {
    content: [
      "外部模型没有按计划规则调用计划预览工具，系统已自动使用确定性训练规则补齐。",
      content
    ].join("\n\n"),
    observations: [
      ...result.observations,
      { tool: "previewPlanWrite", output: visibleOutput }
    ],
    stepNo
  };
}

async function runExternalAgent(args) {
  let result;
  try {
    result = await runNativeExternalAgent(args);
  } catch (error) {
    if (error.code !== "MODEL_TOOLS_UNSUPPORTED" || !error.safeToRetry) {
      throw error;
    }
    result = await runJsonExternalAgent(args);
  }
  return enforcePlanPreview({ ...args, result });
}

async function captureRunMemories({ runId, question, answer, config, signal }) {
  if (config.provider === "local") return { created: [], skipped: [] };
  const startedAt = Date.now();
  try {
    const result = await extractAndSaveMemories({
      config,
      question,
      answer,
      signal
    });
    addAgentStep({
      runId,
      stepNo: MEMORY_STEP_NO,
      type: "memory",
      input: { question },
      output: {
        created: result.created.map((item) => ({
          id: item.id,
          type: item.type,
          content: item.content
        })),
        skipped: result.skipped
      },
      status: "completed",
      durationMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    addAgentStep({
      runId,
      stepNo: MEMORY_STEP_NO,
      type: "memory",
      output: { error: error.message },
      status: "failed",
      durationMs: Date.now() - startedAt
    });
    return { created: [], skipped: [] };
  }
}

async function executeRun(runId, built, question, config, controller) {
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  try {
    emit(runId, "run.started", {
      runId,
      sessionId: built.session.id,
      model: modelLabel(config),
      contextUsage: built.usageEstimate
    });
    const result =
      config.provider === "local"
        ? await runLocalAgent({
            runId,
            built,
            question,
            config,
            signal: controller.signal
          })
        : await runExternalAgent({
            runId,
            built,
            question,
            config,
            signal: controller.signal
          });

    clearTimeout(timeout);
    completeRun({
      runId,
      built,
      question,
      config,
      startedAt,
      answer: result.content,
      observations: result.observations
    });
    await captureRunMemories({
      runId,
      question,
      answer: result.content,
      config,
      signal: controller.signal
    });
  } catch (error) {
    const cancelled =
      error.code === "RUN_CANCELLED" ||
      error.name === "AbortError" ||
      controller.signal.aborted;
    if (!cancelled) {
      const message = error.message || "模型空响应或接口异常";
      try {
        const answer = buildFallbackAnswer({ built, question, reason: message });
        completeRun({
          runId,
          built,
          question,
          config,
          startedAt,
          answer,
          fallback: true,
          fallbackReason: message
        });
        return;
      } catch {
        // Fall through to a failed Run if even deterministic fallback fails.
      }
    }
    const status = cancelled ? "cancelled" : "failed";
    const message = cancelled ? "Agent 运行已取消或超时" : error.message;
    updateAgentRun(runId, {
      status,
      stage: status,
      error: message,
      endedAt: new Date().toISOString()
    });
    addAgentStep({
      runId,
      stepNo: MAX_STEPS + 20,
      type: "error",
      output: { error: message },
      status: "failed"
    });
    emit(runId, cancelled ? "run.cancelled" : "run.failed", {
      runId,
      error: message
    });
  } finally {
    clearTimeout(timeout);
    controllers.delete(runId);
  }
}

export function startAgentRun({
  sessionId,
  question,
  config,
  recordQuestion = true
}) {
  if (!getSession(sessionId)) throw new Error("会话不存在");
  const id = randomUUID();
  const built = buildAgentContext({ sessionId, question });
  const promptVersion = savePromptVersion(
    "running-agent-runtime",
    `${built.systemPrompt}\n${protocolPrompt()}`
  );
  createAgentRun({
    id,
    sessionId,
    question,
    modelLabel: modelLabel(config),
    model: publicModel(config),
    promptVersion,
    context: {
      context: built.context,
      usageEstimate: built.usageEstimate,
      compression: built.compression,
      systemPrompt: `${built.systemPrompt}\n\n${protocolPrompt()}`,
      modelMessages: built.modelMessages,
      tools: getToolDefinitions()
    }
  });
  if (recordQuestion) {
    saveSessionMessage({
      sessionId,
      role: "user",
      content: question,
      tokenCount: estimateTokens(question),
      runId: id
    });
  }
  createChannel(id);
  const controller = new AbortController();
  controllers.set(id, controller);
  executeRun(id, built, question, config, controller).catch((error) => {
    try {
      updateAgentRun(id, {
        status: "failed",
        stage: "failed",
        error: error.message,
        endedAt: new Date().toISOString()
      });
      emit(id, "run.failed", { runId: id, error: error.message });
    } catch {
      // The run is already unusable; never let it crash the server.
    }
    controllers.delete(id);
  });
  return { runId: id, sessionId };
}

export function subscribeRun(runId, response) {
  const run = getAgentRun(runId);
  if (!run) return false;
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.flushHeaders?.();
  const lastEventId = Math.max(
    0,
    Number(response.req?.headers?.["last-event-id"]) || 0
  );

  let channel = channels.get(runId);
  if (!channel) {
    channel = createChannel(runId);
    let sequence = lastEventId;
    const replayedWrite = (event, data) =>
      writeEvent(response, event, data, (sequence += 1));
    replayedWrite("run.started", {
      runId,
      sessionId: run.sessionId,
      model: run.modelLabel,
      replayed: true
    });
    for (const step of listAgentSteps(runId)) {
      if (step.type === "tool") {
        replayedWrite("tool.completed", {
          runId,
          stepNo: step.stepNo,
          toolName: step.toolName,
          output: step.output,
          status: step.status
        });
      }
    }
    if (run.answer) replayedWrite("message.delta", { runId, content: run.answer });
    if (run.status === "completed") {
      replayedWrite("run.completed", {
        runId,
        answer: run.answer,
        model: run.modelLabel,
        usage: run.usage
      });
    } else if (["failed", "cancelled"].includes(run.status)) {
      replayedWrite(
        run.status === "failed" ? "run.failed" : "run.cancelled",
        {
          runId,
          error: run.error
        }
      );
    } else {
      const message = "运行已中断（服务重启或执行器丢失）";
      updateAgentRun(runId, {
        status: "failed",
        stage: "failed",
        error: message,
        endedAt: new Date().toISOString()
      });
      replayedWrite("run.failed", { runId, error: message });
    }
    response.end();
    channels.delete(runId);
    return true;
  }

  for (const item of channel.history) {
    if (item.id > lastEventId) {
      writeEvent(response, item.event, item.data, item.id);
    }
  }
  if (channel.terminal || ["completed", "failed", "cancelled"].includes(run.status)) {
    response.end();
    return true;
  }
  channel.listeners.add(response);
  const heartbeat = setInterval(() => {
    if (response.writableEnded || response.destroyed) {
      clearInterval(heartbeat);
      channel.listeners.delete(response);
      return;
    }
    try {
      response.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      channel.listeners.delete(response);
    }
  }, 15_000);
  heartbeat.unref();
  const detach = () => {
    clearInterval(heartbeat);
    channel.listeners.delete(response);
  };
  response.on("close", detach);
  response.on("error", detach);
  return true;
}

export function cancelAgentRun(runId) {
  const run = getAgentRun(runId);
  if (!run) return false;
  if (run.endedAt || ["completed", "failed", "cancelled"].includes(run.status)) {
    return false;
  }
  const controller = controllers.get(runId);
  if (controller) controller.abort();
  updateAgentRun(runId, {
    status: "cancelled",
    stage: "cancelled",
    error: "用户取消了运行",
    endedAt: new Date().toISOString()
  });
  emit(runId, "run.cancelled", {
    runId,
    error: "用户取消了运行"
  });
  return true;
}

export function getRunDetails(runId) {
  const run = getAgentRun(runId);
  if (!run) return null;
  return {
    ...run,
    steps: listAgentSteps(runId)
  };
}
