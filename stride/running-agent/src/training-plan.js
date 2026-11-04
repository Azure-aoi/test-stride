import { applyPlanConstraints } from "./plan-constraints.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const QUALITY_PATTERN =
  /短加速|短坡|法特莱克|短间歇|节奏|阈值|比赛配速/;

const TEMPLATES = {
  base: {
    title: "基础速度建立周",
    reason:
      "最近周跑量低于 15 km，本周以轻松跑为主，保留两次低风险速度刺激来建立跑姿和神经募集。",
    days: [
      ["休息 / 活动度", "15–20 分钟", "很轻", "让疲劳下降"],
      [
        "轻松跑 + 短加速",
        "30–40 分钟；4×20 秒轻快",
        "其余可完整说话",
        "建立跑姿和步频"
      ],
      ["休息 + 力量", "15 分钟", "轻", "核心、臀腿和小腿稳定"],
      ["轻松跑", "25–35 分钟", "可完整说话", "积累有氧"],
      ["休息 / 散步", "20–30 分钟", "很轻", "主动恢复"],
      [
        "短坡跑或法特莱克",
        "热身 10 分钟；6×30 秒快 / 90 秒慢",
        "快段可控",
        "第二次短速度刺激"
      ],
      ["轻松长距离", "45–60 分钟", "稳定轻松", "建立耐力"]
    ]
  },
  build: {
    title: "稳态进阶周",
    reason:
      "周跑量处于 15–50 km，本周安排两次质量课、一次长距离，其余为轻松跑。",
    days: [
      ["轻松跑", "30–40 分钟", "可完整说话", "积累有氧"],
      [
        "短间歇",
        "热身 15 分钟；6×1 分钟快 / 2 分钟慢",
        "能说短词",
        "提高速度耐力"
      ],
      ["休息 + 力量", "15–20 分钟", "轻", "吸收训练刺激"],
      [
        "节奏跑",
        "热身 10 分钟；2×10 分钟稳快 / 3 分钟慢",
        "可持续但只能说短句",
        "提高阈值能力"
      ],
      ["休息", "—", "—", "为长距离留出恢复"],
      ["长距离", "60–80 分钟", "稳定轻松", "专项耐力"],
      ["恢复跑", "20–30 分钟，可替换为休息", "很轻", "促进恢复"]
    ]
  },
  advanced: {
    title: "比赛专项进阶周",
    reason:
      "周跑量达到 50 km，本周安排两次质量课和一次专项长距离，但质量课之间至少间隔 48 小时。",
    days: [
      ["轻松跑", "30–40 分钟", "可完整说话", "积累有氧"],
      [
        "短间歇",
        "热身 15 分钟；8×1 分钟快 / 2 分钟慢",
        "能说短词",
        "提高速度储备"
      ],
      ["休息 + 力量", "15–20 分钟", "轻", "吸收训练刺激"],
      [
        "阈值或节奏跑",
        "热身 10 分钟；3×10 分钟稳快 / 3 分钟慢",
        "可持续但只能说短句",
        "比赛专项耐力"
      ],
      ["休息或恢复跑", "20–30 分钟", "很轻", "为长距离准备"],
      [
        "长距离 + 后段提速",
        "70–90 分钟；最后 15 分钟稳快",
        "前段轻松，后段可控",
        "专项耐力"
      ],
      ["恢复跑", "20–30 分钟，可替换为休息", "很轻", "促进恢复"]
    ]
  }
};

function racePreparationTemplate(daysToRace, goalPaceLabel = "") {
  const taper = daysToRace <= 14;
  const paceText = goalPaceLabel
    ? `比赛配速约 ${goalPaceLabel}/km`
    : "比赛配速，以可持续且动作稳定为准";
  return {
    title: taper ? "赛前减量与配速周" : "比赛配速专项周",
    reason: `距离比赛 ${daysToRace} 天，减少短间歇和阈值刺激，保留两次比赛配速课并优先长距离专项。`,
    days: [
      ["轻松跑", "30–40 分钟", "可完整说话", "有氧维持"],
      [
        "比赛配速跑",
        taper
          ? `热身 10 分钟；2×8 分钟${paceText} / 3 分钟轻松`
          : `热身 10 分钟；3×10 分钟${paceText} / 3 分钟轻松`,
        "稳定可控，不冲刺",
        "熟悉比赛节奏"
      ],
      ["休息 + 力量", "15–20 分钟", "轻", "稳定与预防伤病"],
      ["轻松跑", "25–40 分钟", "可完整说话", "恢复"],
      ["休息", "—", "—", "为长距离准备"],
      [
        taper ? "减量长距离" : "长距离 + 后段比赛配速",
        taper
          ? "45–60 分钟，可含 10–15 分钟比赛配速"
          : `70–85 分钟；最后 20–30 分钟${paceText}`,
        "前段轻松，后段稳定可控",
        "比赛专项耐力"
      ],
      ["恢复跑", "20–30 分钟，可替换为休息", "很轻", "恢复"]
    ]
  };
}

function weeklyDistance(dashboard) {
  if (!dashboard?.days) return 0;
  return (dashboard.current.distanceKm || 0) / (dashboard.days / 7);
}

function localDateOnly(date) {
  const value = new Date(date);
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 10);
}

function dateOnlyMs(value) {
  const text = String(value || "").slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function daysUntilGoal(goalDate, startDate = new Date()) {
  const goal = dateOnlyMs(goalDate);
  const start = dateOnlyMs(
    startDate instanceof Date ? localDateOnly(startDate) : startDate
  );
  if (goal === null || start === null) return null;
  return Math.round((goal - start) / DAY_MS);
}

export function chooseTrainingTemplate(dashboard, options = {}) {
  const weeklyKm = weeklyDistance(dashboard);
  const goalDate = options.goalDate || options.constraints?.goalDate || null;
  const startDate = options.startDate || new Date();
  const distanceToRace = daysUntilGoal(goalDate, startDate);
  if (
    Number.isFinite(distanceToRace) &&
    distanceToRace >= 0 &&
    distanceToRace <= 30
  ) {
    return "race";
  }
  if (weeklyKm < 15) return "base";
  if (weeklyKm < 50) return "build";
  return "advanced";
}

function decisionBasis(dashboard, templateKey, options = {}) {
  const goalDate = options.constraints?.goalDate || options.goalDate || null;
  const distanceToRace = daysUntilGoal(
    goalDate,
    options.startDate || new Date()
  );
  const weeklyKm = Math.round(weeklyDistance(dashboard) * 10) / 10;
  return {
    template: templateKey,
    recentWeeklyKm: weeklyKm,
    daysToRace: Number.isFinite(distanceToRace) ? distanceToRace : null,
    heartRateUsedForDecision: false,
    rule:
      templateKey === "race"
        ? "距离比赛 30 天以内，减少结构性强度并增加比赛配速与长距离专项"
        : templateKey === "base"
          ? "最近周跑量低于 15 km"
          : templateKey === "build"
            ? "最近周跑量处于 15–50 km"
            : "最近周跑量达到 50 km"
  };
}

function formatDate(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short"
  }).format(date);
}

function parsePlanStart(value) {
  if (value instanceof Date) return new Date(value);
  const text = String(value || "").slice(0, 10);
  const parsed = text ? new Date(`${text}T12:00:00`) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function generateSevenDayPlan(dashboard, options = {}) {
  const settings =
    options instanceof Date ? { startDate: options } : options || {};
  const hasExplicitStart =
    settings.startDate instanceof Date || Boolean(settings.startDate);
  const start = parsePlanStart(settings.startDate);
  if (!hasExplicitStart) start.setDate(start.getDate() + 1);
  const templateKey = chooseTrainingTemplate(dashboard, settings);
  const basis = decisionBasis(dashboard, templateKey, settings);
  const template =
    templateKey === "race"
      ? racePreparationTemplate(
          basis.daysToRace,
          settings.constraints?.goalPaceLabel || ""
        )
      : TEMPLATES[templateKey];
  const days = template.days.map((day, index) => {
    const date = new Date(start);
    date.setDate(date.getDate() + index);
    return {
      date: localDateOnly(date),
      dateLabel: formatDate(date),
      weekday: date.getDay(),
      training: day[0],
      volume: day[1],
      effort: day[2],
      purpose: day[3]
    };
  });
  const intensitySessions = days
    .filter((day) => QUALITY_PATTERN.test(day.training))
    .map((day) => ({
      date: day.date,
      training: day.training
    }));
  const plan = {
    key: templateKey,
    title: template.title,
    reason: template.reason,
    startDate: localDateOnly(start),
    weeklyKm: Math.round(weeklyDistance(dashboard) * 10) / 10,
    daysToRace: basis.daysToRace,
    decisionBasis: basis,
    intensitySessions,
    intensitySessionCount: intensitySessions.length,
    heartRateGuidance:
      settings.heartRateProfile?.guidance ||
      "心率档案只用于训练过程建议，不参与计划难度、强度次数或跑量决策。",
    days,
    adjustment:
      "心率只作过程建议。强度课中如明显不适、心率持续异常升高或动作变形，可降组、减速或停止；不要因为单次心率数值提前删除整周强度。"
  };
  return settings.constraints
    ? applyPlanConstraints(plan, settings.constraints)
    : plan;
}

export function formatSevenDayPlan(plan) {
  const lines = [
    `下周安排：${plan.title}`,
    plan.reason,
    `决策依据：最近周跑量约 ${plan.weeklyKm} km；${
      plan.daysToRace === null
        ? "未设置比赛日期"
        : `距离比赛 ${plan.daysToRace} 天`
    }。心率未参与计划难度和强度数量决策。`,
    "",
    "| 日期 | 训练 | 时长/距离 | 强度 | 目的 |",
    "|---|---|---|---|---|"
  ];
  for (const day of plan.days) {
    lines.push(
      `| ${day.dateLabel || day.date} | ${day.training} | ${day.volume} | ${day.effort} | ${day.purpose} |`
    );
  }
  if (plan.intensitySessions?.length) {
    lines.push(
      "",
      `本周强度安排：${plan.intensitySessions
        .map((item) => `${item.date} ${item.training}`)
        .join("；")}`
    );
  }
  if (plan.constraintLines?.length) {
    lines.push("", `计划约束：${plan.constraintLines.join("；")}`);
  }
  lines.push(
    "",
    `心率建议：${plan.heartRateGuidance}`,
    `调整条件：${plan.adjustment}`
  );
  return lines.join("\n");
}
