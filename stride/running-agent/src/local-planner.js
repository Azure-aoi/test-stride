function localDate(date = new Date()) {
  const value = new Date(date);
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 10);
}

export function analyzeLocalIntent(question) {
  const text = String(question || "").trim();
  const planNoun =
    /计划|课表|日程|训练周|恢复周|减量周|基础周|备赛周/.test(text);
  const strongCreationCue =
    /制定|生成|设计|安排|规划|排[个份]?|编[个份]?|做[个份]?|列[个份]?|写[个份]?|给出/.test(
      text
    );
  const requestCue =
    /给我|帮我|请|想要|需要|准备|接下来|未来|下周|本周|赛前|备赛|七天|7天|一周/.test(
      text
    );
  const evaluationCue =
    /怎么样|如何评价|是否|为什么|分析|评估|检查|看看|合理/.test(text);
  const trainingCue =
    /训练|跑步|跑量|练|周期|强度|长距离|比赛|备赛|减量|恢复/.test(
      text
    );
  const wantsPlan =
    (planNoun && strongCreationCue) ||
    (planNoun && requestCue && !evaluationCue) ||
    (strongCreationCue && trainingCue && requestCue) ||
    (requestCue && /怎么练|如何练/.test(text));
  const wantsActivities = /记录|活动|跑了几次|跑了多少|最近跑|最长距离/.test(text);
  const wantsProfile = /目标|比赛|PB|伤病|偏好|可训练|时间|根据我/.test(text);
  const wantsCalendar = /日历|安排|课表|冲突|计划|下周|本周|写入|写回/.test(text);
  const wantsMemory = /记得|偏好|习惯|以前|历史|根据我/.test(text);
  const wantsKnowledge = /为什么|原则|如何|怎么|方法|恢复|减量|周期|节奏|间歇/.test(text);
  const wantsSync = /同步|更新.*数据|高驰.*数据/.test(text);
  const target = /高驰|COROS/i.test(text) ? "coros" : "local";
  return {
    question: text,
    wantsPlan,
    wantsActivities,
    wantsProfile,
    wantsCalendar,
    wantsMemory,
    wantsKnowledge,
    wantsSync,
    target,
    startDate: localDate()
  };
}

export function nextLocalAction({ intent, completed }) {
  const done = (name) => completed.has(name);
  if (intent.wantsSync && !done("syncActivitySource")) {
    return {
      tool: "syncActivitySource",
      arguments: { source: "coros", days: 30 },
      summary: "先更新高驰训练数据"
    };
  }
  if (!done("getTrainingMetrics")) {
    return {
      tool: "getTrainingMetrics",
      arguments: { days: 28 },
      summary: "读取最近 28 天训练指标"
    };
  }
  if (intent.wantsActivities && !done("getRecentActivities")) {
    return {
      tool: "getRecentActivities",
      arguments: { limit: 10 },
      summary: "读取最近跑步活动"
    };
  }
  if ((intent.wantsProfile || intent.wantsPlan) && !done("getRunnerProfile")) {
    return {
      tool: "getRunnerProfile",
      arguments: {},
      summary: "读取跑者目标、时间和伤病限制"
    };
  }
  if ((intent.wantsCalendar || intent.wantsPlan) && !done("getTrainingCalendar")) {
    return {
      tool: "getTrainingCalendar",
      arguments: {},
      summary: "检查已有训练日历和冲突"
    };
  }
  if ((intent.wantsMemory || intent.wantsPlan) && !done("searchMemories")) {
    return {
      tool: "searchMemories",
      arguments: { query: intent.question, limit: 5 },
      summary: "检索跑者长期记忆"
    };
  }
  if ((intent.wantsKnowledge || intent.wantsPlan) && !done("searchTrainingKnowledge")) {
    return {
      tool: "searchTrainingKnowledge",
      arguments: { query: intent.question, limit: 4 },
      summary: "检索训练原则和规划规则"
    };
  }
  if (intent.wantsPlan && !done("previewPlanWrite")) {
    return {
      tool: "previewPlanWrite",
      arguments: {
        startDate: intent.startDate,
        target: intent.target
      },
      summary:
        intent.target === "coros"
          ? "生成高驰写入预览"
          : "生成本地训练日历预览"
    };
  }
  return { type: "final" };
}
