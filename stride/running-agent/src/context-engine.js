import { buildSystemPrompt } from "./coach.js";
import {
  buildHeartRateProfile,
  calculateDashboard,
  resolveAnalysisWindow
} from "./metrics.js";
import { listActivities } from "./db.js";
import {
  estimateTokens,
  getRunnerProfile,
  getSession,
  listMemories,
  listSessionMessages,
  listTrainingSessions,
  searchMemories,
  updateSession
} from "./agent-store.js";
import { searchTrainingKnowledge } from "./knowledge-rag.js";

export const DEFAULT_CONTEXT_BUDGET = 6000;
const MAX_CONTEXT_MEMORIES = 40;
const MAX_CONTEXT_MEMORY_CHARS = 4000;

function localDate(date) {
  const value = new Date(date);
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 10);
}

function compactRun(run) {
  return {
    date: run.startedAt,
    title: run.raw?.title || "跑步训练",
    distanceKm: Number((run.distanceM / 1000).toFixed(2)),
    paceSecPerKm: run.avgPaceSecPerKm,
    avgHeartRate: run.avgHeartRate,
    cadence: run.cadence,
    trainingLoad: run.trainingLoad,
    source: run.provider
  };
}

function compactMessage(message) {
  return {
    role: message.role,
    content: String(message.content || "").slice(0, 1200),
    createdAt: message.createdAt
  };
}

function deterministicSummary(messages) {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "教练" : "用户";
      const content = String(message.content || "")
        .replace(/\s+/g, " ")
        .slice(0, 220);
      return `${role}：${content}`;
    })
    .join("\n");
}

function selectConversation(session, budget) {
  const messages = listSessionMessages(session.id, 60);
  const cutoff = session.summaryUntil || null;
  const unsummarized = cutoff
    ? messages.filter(
        (message) =>
          !message.createdAt || String(message.createdAt) > String(cutoff)
      )
    : messages;
  const summary = session.summary || null;
  const summaryTokens = estimateTokens(summary || "");
  const unsummarizedTokens = unsummarized.reduce(
    (sum, message) => sum + (message.tokenCount || estimateTokens(message.content)),
    0
  );
  const totalTokens = summaryTokens + unsummarizedTokens;
  if (totalTokens <= budget * 0.7) {
    return {
      messages: unsummarized.map(compactMessage),
      summary,
      originalTokens: totalTokens,
      compressed: false
    };
  }

  const recent = unsummarized.slice(-4);
  const older = unsummarized.slice(0, -4);
  const newSummary = [summary, deterministicSummary(older)]
    .filter(Boolean)
    .join("\n")
    .slice(-6000);
  const lastMessage = older.at(-1);
  if (lastMessage) {
    updateSession(session.id, {
      summary: newSummary,
      summaryUntil: lastMessage.createdAt
    });
  }
  return {
    messages: recent.map(compactMessage),
    summary: newSummary,
    originalTokens: totalTokens,
    compressed: Boolean(older.length)
  };
}

function withinCharacters(value, maxCharacters) {
  const text = JSON.stringify(value);
  if (text.length <= maxCharacters) return value;
  return {
    truncated: true,
    note: "上下文超出预算，已保留核心聚合指标并截断部分活动。",
    summary: value.summary,
    changes: value.changes,
    readiness: value.readiness,
    recentRuns: value.recentRuns.slice(0, 3)
  };
}

function selectContextMemories(relevant, all) {
  const selected = [];
  const seen = new Set();
  let characters = 0;

  for (const memory of [...relevant, ...all]) {
    if (!memory?.id || seen.has(memory.id)) continue;
    const content = String(memory.content || "");
    if (
      selected.length >= MAX_CONTEXT_MEMORIES ||
      characters + content.length > MAX_CONTEXT_MEMORY_CHARS
    ) {
      break;
    }
    seen.add(memory.id);
    selected.push(memory);
    characters += content.length;
  }

  return selected;
}

export function buildAgentContext({ sessionId, question, maxTokens = DEFAULT_CONTEXT_BUDGET }) {
  const session = getSession(sessionId);
  if (!session) throw new Error("会话不存在");

  const activities = listActivities({ limit: 1000 });
  const analysisWindow = resolveAnalysisWindow(activities, 28);
  const dashboard = calculateDashboard(activities, 28, analysisWindow.anchor);
  const heartRateProfile = buildHeartRateProfile(activities);
  const profile = getRunnerProfile();
  const planMemories = listMemories(100);
  const relevantMemories = searchMemories(question, 5);
  const memories = selectContextMemories(relevantMemories, planMemories);
  const knowledge = searchTrainingKnowledge(question, 4);
  const calendarStart = new Date();
  calendarStart.setDate(calendarStart.getDate() - 7);
  const calendarEnd = new Date();
  calendarEnd.setDate(calendarEnd.getDate() + 14);
  const trainingCalendar = listTrainingSessions({
    start: localDate(calendarStart),
    end: localDate(calendarEnd)
  });

  const conversationBudget = Math.floor(maxTokens * 0.35);
  const conversation = selectConversation(session, conversationBudget);
  const recentRuns = activities.slice(0, 10).map(compactRun);
  const dataContext = withinCharacters(
    {
      analysisNote: analysisWindow.isHistorical
        ? `最近 28 天没有训练，使用截至 ${analysisWindow.latest?.toISOString()} 的历史窗口。`
        : null,
      summary: dashboard.current,
      previousPeriod: dashboard.previous,
      changes: dashboard.changes,
      readiness: dashboard.readiness,
      recentRuns
    },
    Math.floor(maxTokens * 0.3) * 4
  );

  const basePrompt = buildSystemPrompt();
  const systemPayload = {
    profile,
    heartRateProfile,
    memories: [...memories],
    knowledge: [...knowledge],
    trainingCalendar: [...trainingCalendar],
    conversationSummary: conversation.summary,
    training: {
      ...dataContext,
      recentRuns: [...(dataContext.recentRuns || [])]
    }
  };
  const systemInstructions = [
    "你是 Running Agent 的执行核心。你可以根据用户目标选择只读工具获取事实，再生成最终回答。",
    "工具结果高于模型记忆；没有数据时明确说明，不得编造活动、身体指标或训练完成情况。",
    "profile 和 memories 是用户主动保存的长期事实与训练约束。必须主动遵守，即使当前问题没有出现相同关键词，也不得忽略其中的伤病、可用时间、目标或个人偏好。",
    "训练计划决策只能使用最近跑量、距离比赛天数、可训练日、伤病限制和用户偏好，不得使用心率选择模板、取消强度或减少强度次数。",
    "距离比赛超过 30 天时至少安排两次速度或节奏刺激；距离比赛 30 天以内时减少短间歇，增加比赛配速跑和专项长距离。",
    "heartRateProfile 只用于过程建议。可以在强度课中提醒跑者根据实时感觉降组、减速或停止，但必须保留计划中的强度课。",
    "写入工具必须先返回预览，绝不能把预览当作已经完成。",
    "输出给用户的最终内容使用中文纯文本，结构清晰，不使用 Markdown 表格。",
    `服务端本轮已经加载 ${activities.length} 条训练记录。下面 JSON 是真实训练事实，若其中存在记录，禁止回答“没有训练数据”或“找不到训练记录”。`
  ];
  const renderSystemContext = () =>
    [
      basePrompt,
      ...systemInstructions,
      JSON.stringify(systemPayload, null, 2)
    ].join("\n\n");

  let systemContext = renderSystemContext();
  let systemTokens = estimateTokens(systemContext);
  const conversationTokens = conversation.messages.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0
  );
  const questionTokens = estimateTokens(question);
  while (
    systemTokens + conversationTokens + questionTokens > maxTokens
  ) {
    let changed = false;
    if (systemPayload.memories.length > 5) {
      systemPayload.memories = systemPayload.memories.slice(0, -1);
      changed = true;
    } else if (systemPayload.knowledge.length > 1) {
      systemPayload.knowledge = systemPayload.knowledge.slice(0, -1);
      changed = true;
    } else if (systemPayload.trainingCalendar.length > 7) {
      systemPayload.trainingCalendar =
        systemPayload.trainingCalendar.slice(0, 7);
      changed = true;
    } else if (systemPayload.training.recentRuns.length > 3) {
      systemPayload.training.recentRuns =
        systemPayload.training.recentRuns.slice(0, 3);
      changed = true;
    } else if (
      systemPayload.conversationSummary &&
      systemPayload.conversationSummary.length > 1200
    ) {
      systemPayload.conversationSummary =
        systemPayload.conversationSummary.slice(-1200);
      changed = true;
    } else if (systemPayload.training.previousPeriod) {
      systemPayload.training.previousPeriod = null;
      changed = true;
    }
    if (!changed) break;
    systemContext = renderSystemContext();
    systemTokens = estimateTokens(systemContext);
  }

  const selectedContext = {
    question,
    profile,
    heartRateProfile,
    memories: systemPayload.memories,
    knowledge: systemPayload.knowledge,
    trainingCalendar: systemPayload.trainingCalendar,
    conversationSummary: systemPayload.conversationSummary,
    recentMessages: conversation.messages,
    training: systemPayload.training
  };
  const usageEstimate = {
    system: systemTokens,
    conversation: conversationTokens,
    question: questionTokens,
    budget: maxTokens,
    total: systemTokens + conversationTokens + questionTokens,
    budgetSatisfied:
      systemTokens + conversationTokens + questionTokens <= maxTokens
  };

  return {
    session,
    activities,
    dashboard,
    analysisWindow,
    profile,
    heartRateProfile,
    memories: systemPayload.memories,
    planMemories,
    knowledge: systemPayload.knowledge,
    trainingCalendar: systemPayload.trainingCalendar,
    systemPrompt: systemContext,
    modelMessages: conversation.messages,
    context: selectedContext,
    usageEstimate,
    compression: {
      applied: conversation.compressed,
      originalConversationTokens: conversation.originalTokens,
      retainedMessages: conversation.messages.length
    }
  };
}
