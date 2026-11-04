import { listActivities, removeDemoActivities, saveActivities } from "./db.js";
import {
  buildHeartRateProfile,
  calculateDashboard,
  resolveAnalysisWindow
} from "./metrics.js";
import { generateSevenDayPlan } from "./training-plan.js";
import {
  corosStatus,
  createCorosScheduledWorkout,
  syncCorosActivities
} from "./coros.js";
import {
  consumeConfirmation,
  createConfirmation,
  getRunnerProfile,
  listMemories,
  listTrainingSessions,
  saveTrainingSessions,
  searchMemories
} from "./agent-store.js";
import { buildPlanConstraints } from "./plan-constraints.js";
import { searchTrainingKnowledge } from "./knowledge-rag.js";
import { validateToolArguments } from "./tool-schema.js";

const tools = new Map();

function defineTool(tool) {
  tools.set(tool.name, tool);
}

function compactActivity(activity) {
  return {
    id: activity.externalId,
    date: activity.startedAt,
    title: activity.raw?.title || "跑步训练",
    distanceKm: Number((activity.distanceM / 1000).toFixed(2)),
    durationSec: activity.durationSec,
    paceSecPerKm: activity.avgPaceSecPerKm,
    avgHeartRate: activity.avgHeartRate,
    maxHeartRate: activity.maxHeartRate,
    cadence: activity.cadence,
    trainingLoad: activity.trainingLoad,
    source: activity.provider
  };
}

function dateOnly(date) {
  const value = new Date(date);
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 10);
}

function parseStartDate(value) {
  const parsed = value ? new Date(`${String(value).slice(0, 10)}T12:00:00`) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function planToCalendarSessions(plan, startDate, target = "local") {
  const start = parseStartDate(startDate);
  return plan.days.map((day, index) => {
    let date = day.date;
    if (!date) {
      const value = new Date(start);
      value.setDate(value.getDate() + index);
      date = dateOnly(value);
    }
    return {
      date,
      status: "planned",
      workout: {
        title: day.training,
        volume: day.volume,
        effort: day.effort,
        purpose: day.purpose,
        planTitle: plan.title,
        planReason: plan.reason,
        adjustment: plan.adjustment,
        target
      }
    };
  });
}

function estimateWorkoutMinutes(day) {
  const text = `${day.training} ${day.volume}`;
  if (/长距离/.test(day.training)) return 70;
  if (/间歇|法特莱克|坡|节奏/.test(day.training)) return 40;
  const numbers = [...text.matchAll(/(\d+(?:\.\d+)?)\s*分钟/g)].map((match) =>
    Number(match[1])
  );
  if (numbers.length) {
    return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
  }
  return 30;
}

function corosCourseForDay(day) {
  const minutes = Math.max(10, Math.min(120, estimateWorkoutMinutes(day)));
  const intensity = /稳快|节奏|间歇|坡/.test(`${day.training} ${day.effort}`) ? 3 : 1;
  return {
    courseName: String(day.training).slice(0, 100),
    courseDescription: `${day.volume}；强度：${day.effort}；目的：${day.purpose}`,
    sportType: 1,
    sections: [
      {
        sectionType: 2,
        targetType: 2,
        targetValue: minutes * 60,
        intensityType: 1,
        sectionIntensity: intensity
      }
    ]
  };
}

function isExternalRunnable(day) {
  return !/休息|力量|散步|活动度/.test(day.training);
}

defineTool({
  name: "getRecentActivities",
  description: "查询最近跑步活动，返回日期、距离、配速、心率和负荷。",
  type: "read",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 30, default: 10 }
    },
    additionalProperties: false
  },
  async execute(args) {
    const limit = Math.max(1, Math.min(30, Number(args.limit) || 10));
    return {
      activities: listActivities({ limit }).map(compactActivity)
    };
  }
});

defineTool({
  name: "searchTrainingKnowledge",
  description: "从本地精英训练 Skill 中检索与当前问题相关的训练原则和计划规则。",
  type: "read",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 6, default: 4 }
    },
    required: ["query"],
    additionalProperties: false
  },
  async execute(args) {
    return {
      knowledge: searchTrainingKnowledge(
        String(args.query || ""),
        Math.max(1, Math.min(6, Number(args.limit) || 4))
      )
    };
  }
});

defineTool({
  name: "getTrainingMetrics",
  description: "计算指定天数的跑量、配速、心率、训练负荷、恢复节奏和上一周期变化。",
  type: "read",
  parameters: {
    type: "object",
    properties: {
      days: { type: "integer", enum: [7, 28, 56, 90], default: 28 }
    },
    additionalProperties: false
  },
  async execute(args) {
    const days = [7, 28, 56, 90].includes(Number(args.days))
      ? Number(args.days)
      : 28;
    const activities = listActivities({ limit: 1000 });
    const analysisWindow = resolveAnalysisWindow(activities, days);
    const dashboard = calculateDashboard(activities, days, analysisWindow.anchor);
    return {
      days,
      current: dashboard.current,
      previous: dashboard.previous,
      changes: dashboard.changes,
      readiness: dashboard.readiness,
      heartRateProfile: buildHeartRateProfile(activities),
      historicalWindow: analysisWindow.isHistorical,
      analysisAnchor: analysisWindow.anchor.toISOString()
    };
  }
});

defineTool({
  name: "getTrainingCalendar",
  description: "读取最近和未来训练日历，包括计划课程、完成状态、RPE 和备注。",
  type: "read",
  parameters: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "yyyy-mm-dd" },
      endDate: { type: "string", description: "yyyy-mm-dd" }
    },
    additionalProperties: false
  },
  async execute(args) {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    const end = new Date();
    end.setDate(end.getDate() + 14);
    return {
      sessions: listTrainingSessions({
        start: String(args.startDate || dateOnly(start)).slice(0, 10),
        end: String(args.endDate || dateOnly(end)).slice(0, 10)
      })
    };
  }
});

defineTool({
  name: "getRunnerProfile",
  description: "读取跑者的目标比赛、成绩、可训练时间、偏好和伤病限制。",
  type: "read",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute() {
    return { profile: getRunnerProfile() };
  }
});

defineTool({
  name: "searchMemories",
  description: "检索与当前问题相关的长期记忆、偏好和历史决策。",
  type: "read",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 10, default: 5 }
    },
    required: ["query"],
    additionalProperties: false
  },
  async execute(args) {
    return {
      memories: searchMemories(
        String(args.query || ""),
        Math.max(1, Math.min(10, Number(args.limit) || 5))
      )
    };
  }
});

defineTool({
  name: "generateTrainingPlan",
  description: "根据近期训练指标生成未来 7 天训练计划草稿，不写入日历。",
  type: "read",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  async execute() {
    const activities = listActivities({ limit: 1000 });
    const anchor = resolveAnalysisWindow(activities, 28);
    const dashboard = calculateDashboard(activities, 28, anchor.anchor);
    const startDate = dateOnly(new Date());
    const constraints = buildPlanConstraints({
      profile: getRunnerProfile(),
      memories: listMemories(100),
      startDate
    });
    const plan = generateSevenDayPlan(dashboard, {
      startDate,
      constraints,
      heartRateProfile: buildHeartRateProfile(activities)
    });
    return { plan, constraints };
  }
});

defineTool({
  name: "syncActivitySource",
  description: "同步外部运动平台记录。目前仅支持 COROS，写入前应让用户知道会更新本地数据。",
  type: "write",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", enum: ["coros"] },
      days: { type: "integer", minimum: 1, maximum: 90, default: 30 }
    },
    required: ["source"],
    additionalProperties: false
  },
  async execute(args, context = {}) {
    if (args.source !== "coros") throw new Error("暂不支持该数据源");
    const days = Math.max(1, Math.min(90, Number(args.days) || 30));
    const result = await syncCorosActivities(days, { signal: context.signal });
    if (!result.activities.length) {
      return { source: "coros", imported: 0, updated: 0, message: "没有可导入的跑步记录" };
    }
    const saved = saveActivities(result.activities, null, { updateExisting: true });
    if (saved.inserted > 0) removeDemoActivities();
    return {
      source: "coros",
      imported: saved.inserted,
      updated: saved.updated,
      skipped: saved.skipped,
      fetched: result.recordCount,
      ignored: result.ignoredCount || 0
    };
  }
});

defineTool({
  name: "previewPlanWrite",
  description: "生成训练计划写入预览和一次性确认令牌。本工具不会直接写入日历。",
  type: "read",
  parameters: {
    type: "object",
    properties: {
      startDate: { type: "string", description: "yyyy-mm-dd" },
      target: { type: "string", enum: ["local", "coros"], default: "local" }
    },
    additionalProperties: false
  },
  async execute(args, context) {
    const activities = listActivities({ limit: 1000 });
    const anchor = resolveAnalysisWindow(activities, 28);
    const dashboard = calculateDashboard(activities, 28, anchor.anchor);
    const startDate = dateOnly(parseStartDate(args.startDate));
    const constraints = buildPlanConstraints({
      profile: getRunnerProfile(),
      memories: listMemories(100),
      startDate
    });
    const plan = generateSevenDayPlan(dashboard, {
      startDate,
      constraints,
      heartRateProfile: buildHeartRateProfile(activities)
    });
    const target = args.target === "coros" ? "coros" : "local";
    const sessions = planToCalendarSessions(plan, startDate, target);
    const conflicts = listTrainingSessions({
      start: sessions[0].date,
      end: sessions.at(-1).date
    }).map((item) => ({
      id: item.id,
      date: item.date,
      title: item.workout?.title || "训练",
      status: item.status,
      source: item.source
    }));
    sessions.forEach((session, index) => {
      const day = plan.days[index];
      session.workout.corosEligible = target === "coros" && isExternalRunnable(day);
      session.workout.corosCourse = session.workout.corosEligible
        ? corosCourseForDay(day)
        : null;
    });
    const confirmation = createConfirmation({
      runId: context.runId,
      toolName: "publishPlan",
      payload: {
        plan,
        sessions,
        target
      }
    });
    return {
      plan,
      sessions,
      target,
      constraints,
      constraintLines: plan.constraintLines || constraints.constraintLines || [],
      conflicts,
      hasConflicts: conflicts.length > 0,
      sourceConnected: corosStatus().connected,
      confirmationToken: confirmation.token,
      expiresAt: confirmation.expiresAt,
      writeMode:
        target === "coros"
          ? "用户确认后创建高驰可执行课程，休息和力量日只保留在本地"
          : "本地训练日历",
      message: "这是写入预览，尚未修改训练日历。"
    };
  }
});

defineTool({
  name: "publishPlan",
  description: "使用用户确认后的一次性令牌，把计划写入本地训练日历，并保留外部目标标记。",
  type: "write",
  parameters: {
    type: "object",
    properties: {
      confirmationToken: { type: "string" }
    },
    required: ["confirmationToken"],
    additionalProperties: false
  },
  async execute(args, context) {
    const confirmation = consumeConfirmation(
      String(args.confirmationToken || ""),
      "publishPlan"
    );
    if (!confirmation) {
      throw new Error("确认令牌无效、已使用或已过期");
    }
    const externalResults = [];
    if (confirmation.payload.target === "coros") {
      if (!corosStatus().connected) {
        throw new Error("高驰尚未连接，无法写入");
      }
      for (const session of confirmation.payload.sessions) {
        if (context.signal?.aborted) throw cancellationError();
        if (!session.workout?.corosEligible || !session.workout?.corosCourse) {
          externalResults.push({
            date: session.date,
            status: "skipped",
            reason: "休息、活动度或力量课程不写入高驰"
          });
          continue;
        }
        try {
          const result = await createCorosScheduledWorkout(
            session.date.replaceAll("-", ""),
            session.workout.corosCourse,
            { signal: context.signal }
          );
          externalResults.push({
            date: session.date,
            status: "created",
            result: result.structuredContent || result.content
          });
          session.workout.corosWrite = {
            status: "created",
            completedAt: new Date().toISOString()
          };
        } catch (error) {
          externalResults.push({
            date: session.date,
            status: "failed",
            reason: error.message
          });
          session.workout.corosWrite = {
            status: "failed",
            error: error.message
          };
        }
      }
    }
    const sessions = saveTrainingSessions({
      sessions: confirmation.payload.sessions,
      source: confirmation.payload.target === "coros" ? "coros-planned" : "agent",
      runId: context.runId
    });
    return {
      published: sessions.length,
      target: confirmation.payload.target,
      externalResults,
      message:
        confirmation.payload.target === "coros"
          ? `已写入本地训练日历；高驰成功 ${
              externalResults.filter((item) => item.status === "created").length
            } 节，失败 ${
              externalResults.filter((item) => item.status === "failed").length
            } 节。`
          : "训练计划已写入本地训练日历。",
      sessions
    };
  }
});

export function getToolDefinitions() {
  return [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    type: tool.type,
    parameters: tool.parameters
  }));
}

export function describeToolsForPrompt() {
  return JSON.stringify(getToolDefinitions(), null, 2);
}

function cancellationError() {
  const error = new Error("Agent 运行已取消");
  error.code = "RUN_CANCELLED";
  return error;
}

export async function executeAgentTool(name, args = {}, context = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`未知工具：${name}`);
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    const error = new Error("工具参数必须是 JSON 对象");
    error.status = 400;
    error.code = "TOOL_ARGUMENTS_INVALID";
    throw error;
  }
  validateToolArguments(tool.parameters, args);
  if (context.signal?.aborted) throw cancellationError();
  try {
    return await tool.execute(args, context);
  } catch (error) {
    if (context.signal?.aborted && error.code !== "RUN_CANCELLED") {
      throw cancellationError();
    }
    throw error;
  }
}
