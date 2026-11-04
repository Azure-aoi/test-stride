import { formatPace } from "./metrics.js";

const WEEKDAY_VALUES = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0
};

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const UNAVAILABLE_CUE =
  /没空|没时间|没有时间|没有空|不方便|不行|不能|无法|跑不了|去不了|不能跑|无法跑|不跑|有事|加班|上班|值班|出差|太忙|很忙|忙|上课|有课|带娃|应酬|聚会|没精力|不可用|不训练|休息/;
const AVAILABLE_CUE = /有空|有时间|可以|能跑|可以跑|方便|安排|训练|跑步/;
const INJURY_CUE = /伤病|受伤|膝|踝|跟腱|足底|腰|胫骨|髂胫束/;
const INJURY_LIMIT_CUE = /避免|不能|限制|不适|疼|痛|恢复|减少/;
const WEEKDAY_PATTERN = /(?:周|星期|礼拜)[一二三四五六日天]|周末|工作日/g;

export function weekdayLabel(value) {
  return WEEKDAY_LABELS[Number(value)] || "";
}

function clauseAt(text, index) {
  const separators = /[，。；！？,;!?\n\s]/;
  let start = index;
  while (start > 0 && !separators.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !separators.test(text[end])) end += 1;
  return text.slice(start, end);
}

function weekdayValues(label) {
  if (label === "周末") return [6, 0];
  if (label === "工作日") return [1, 2, 3, 4, 5];
  const value = WEEKDAY_VALUES[label.at(-1)];
  return value === undefined ? [] : [value];
}

function parseLabels(text) {
  return String(text || "").match(WEEKDAY_PATTERN) || [];
}

export function parseAvailableDays(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const available = new Set();
  const rangePattern =
    /(?:周|星期|礼拜)([一二三四五六日天])\s*(?:到|至|-|~|—)\s*(?:周|星期|礼拜)([一二三四五六日天])/g;
  let range;
  while ((range = rangePattern.exec(text))) {
    const start = WEEKDAY_VALUES[range[1]];
    const end = WEEKDAY_VALUES[range[2]];
    if (start === undefined || end === undefined) continue;
    for (let value = start; ; value = (value + 1) % 7) {
      available.add(value);
      if (value === end) break;
    }
  }
  for (const label of parseLabels(text)) {
    for (const value of weekdayValues(label)) available.add(value);
  }
  return available.size ? available : null;
}

function parseDurationSeconds(value) {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function goalPace(profile) {
  const race = String(profile?.goalRace || "").trim();
  const durationSec = parseDurationSeconds(profile?.targetTime);
  if (!durationSec) return null;
  const distanceKm = /半程|半马/.test(race)
    ? 21.0975
    : /10\s*k|10\s*公里|十公里/i.test(race)
      ? 10
      : /5\s*k|5\s*公里|五公里/i.test(race)
        ? 5
        : /马拉松/.test(race)
          ? 42.195
          : null;
  if (!distanceKm) return null;
  const paceSecPerKm = Math.round(durationSec / distanceKm);
  return {
    distanceKm,
    paceSecPerKm,
    label: formatPace(paceSecPerKm)
  };
}

export function extractWeekdayAvailability(text) {
  const source = String(text || "");
  const unavailable = new Set();
  const available = new Set();
  const pattern = new RegExp(WEEKDAY_PATTERN.source, "g");
  let match;
  while ((match = pattern.exec(source))) {
    const clause = clauseAt(source, match.index);
    const values = weekdayValues(match[0]);
    if (!values.length) continue;
    if (UNAVAILABLE_CUE.test(clause)) {
      values.forEach((value) => unavailable.add(value));
    } else if (AVAILABLE_CUE.test(clause)) {
      values.forEach((value) => available.add(value));
    } else {
      values.forEach((value) => available.add(value));
    }
  }
  if (/只有.*周末.*(?:有空|有时间|能跑)/.test(source)) {
    [1, 2, 3, 4, 5].forEach((value) => unavailable.add(value));
  }
  if (/工作日.*(?:没空|没时间|要上班|上班|加班)/.test(source)) {
    [1, 2, 3, 4, 5].forEach((value) => unavailable.add(value));
  }
  if (/周末.*(?:没空|没时间|要上班|加班|有课)/.test(source)) {
    [6, 0].forEach((value) => unavailable.add(value));
  }
  return { unavailable, available };
}

function preferredLongRunDay(profile, memories) {
  const configured = parseLabels(profile?.preferredLongRunDay || "");
  if (configured.length) return weekdayValues(configured[0])[0] ?? null;
  for (const memory of memories) {
    const text = String(memory?.content || "");
    if (!/长距离|LSD/i.test(text)) continue;
    const labels = parseLabels(text);
    for (const label of labels) {
      const values = weekdayValues(label);
      if (values.length === 1) return values[0];
    }
  }
  return null;
}

export function buildPlanConstraints({ profile = {}, memories = [], startDate = null } = {}) {
  const unavailable = new Set();
  const available = new Set();
  let injuryNotes = String(profile.injuryNotes || "").trim();
  let injuryLimited = Boolean(injuryNotes);

  for (const memory of memories) {
    const content = String(memory?.content || "");
    if (!content) continue;
    const result = extractWeekdayAvailability(content);
    result.unavailable.forEach((value) => unavailable.add(value));
    result.available.forEach((value) => available.add(value));
    if (memory?.type === "injury" && !injuryLimited) {
      injuryNotes = content;
      injuryLimited = true;
    } else if (INJURY_CUE.test(content) && INJURY_LIMIT_CUE.test(content)) {
      injuryLimited = true;
      if (!injuryNotes) injuryNotes = content;
    }
  }

  const profileAvailable = parseAvailableDays(profile.availableDays);
  if (profileAvailable) {
    profileAvailable.forEach((value) => available.add(value));
    for (let value = 0; value < 7; value += 1) {
      if (!profileAvailable.has(value)) unavailable.add(value);
    }
  }
  unavailable.forEach((value) => available.delete(value));

  const plannedLongRunDay = preferredLongRunDay(profile, memories);
  const targetPace = goalPace(profile);
  const constraints = {
    startDate,
    unavailableWeekdays: [...unavailable].sort((a, b) => a - b),
    availableWeekdays: [...available].sort((a, b) => a - b),
    preferredLongRunDay: plannedLongRunDay,
    injuryNotes,
    injuryLimited,
    goalRace: String(profile.goalRace || "").trim(),
    goalDate: String(profile.goalDate || "").trim(),
    targetTime: String(profile.targetTime || "").trim(),
    goalDistanceKm: targetPace?.distanceKm || null,
    goalPaceSecPerKm: targetPace?.paceSecPerKm || null,
    goalPaceLabel: targetPace?.label || "",
    memoryIds: memories.map((item) => item?.id).filter(Boolean)
  };
  constraints.constraintLines = constraintLines(constraints);
  return constraints;
}

export function constraintLines(constraints) {
  if (!constraints) return [];
  const lines = [];
  if (constraints.unavailableWeekdays?.length) {
    lines.push(
      `不可训练日：${constraints.unavailableWeekdays.map(weekdayLabel).join("、")}`
    );
  }
  if (Number.isInteger(constraints.preferredLongRunDay)) {
    lines.push(`偏好长距离日：${weekdayLabel(constraints.preferredLongRunDay)}`);
  }
  if (constraints.injuryLimited) {
    lines.push(`伤病限制：${constraints.injuryNotes || "避免高强度课程"}`);
  }
  if (constraints.goalRace) {
    lines.push(
      `目标比赛：${constraints.goalRace}${
        constraints.goalDate ? `（${constraints.goalDate}）` : ""
      }${
        constraints.goalPaceLabel
          ? `，目标配速 ${constraints.goalPaceLabel}/km`
          : ""
      }`
    );
  }
  return lines;
}

function weekdayOfDate(dateOnly) {
  const date = new Date(`${String(dateOnly).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.getDay();
}

function isRestDay(day) {
  return /休息|恢复|散步|活动度/.test(day.training);
}

function isQualityDay(day) {
  return /长距离|间歇|法特莱克|坡|节奏/.test(day.training);
}

const REST_FIELDS = {
  training: "休息",
  volume: "—",
  effort: "—",
  purpose: "按长期记忆或跑者档案的不可用日安排休息"
};

function moveTraining(from, to, reason) {
  const fields = ["training", "volume", "effort", "purpose"];
  const moved = {};
  for (const field of fields) {
    moved[field] = from[field];
    from[field] = to[field];
    to[field] = moved[field];
  }
  to.purpose = `${to.purpose}（从${weekdayLabel(weekdayOfDate(from.date))}调整，${reason}）`;
  Object.assign(from, REST_FIELDS);
}

export function applyPlanConstraints(plan, constraints) {
  if (!constraints || !plan?.days?.length) return plan;
  const blocked = new Set(constraints.unavailableWeekdays || []);
  const days = plan.days.map((day) => ({ ...day }));
  const usedSlots = new Set();
  const notes = [];

  const findRestSlot = (index) => {
    for (let distance = 1; distance < days.length; distance += 1) {
      for (const candidate of [index + distance, index - distance]) {
        if (candidate < 0 || candidate >= days.length) continue;
        if (usedSlots.has(candidate)) continue;
        const weekday = weekdayOfDate(days[candidate].date);
        if (weekday === null || blocked.has(weekday)) continue;
        if (!isRestDay(days[candidate])) continue;
        return candidate;
      }
    }
    return -1;
  };

  days.forEach((day, index) => {
    const weekday = weekdayOfDate(day.date);
    if (weekday === null || !blocked.has(weekday)) return;
    if (!isQualityDay(day)) return;
    const slot = findRestSlot(index);
    if (slot === -1) {
      Object.assign(day, REST_FIELDS);
      notes.push(`${weekdayLabel(weekday)}是重点课但无可用日，已改为休息`);
      return;
    }
    usedSlots.add(slot);
    moveTraining(day, days[slot], "避开不可用日");
  });

  days.forEach((day) => {
    const weekday = weekdayOfDate(day.date);
    if (weekday === null || !blocked.has(weekday)) return;
    Object.assign(day, REST_FIELDS);
    day.constraintNote = "不可训练日";
  });

  const preferred = constraints.preferredLongRunDay;
  if (Number.isInteger(preferred) && !blocked.has(preferred)) {
    const longIndex = days.findIndex((day) => /长距离/.test(day.training));
    const preferredIndex = days.findIndex(
      (day) => weekdayOfDate(day.date) === preferred
    );
    if (
      longIndex >= 0 &&
      preferredIndex >= 0 &&
      longIndex !== preferredIndex &&
      isRestDay(days[preferredIndex])
    ) {
      moveTraining(days[longIndex], days[preferredIndex], "按偏好安排长距离");
    }
  }

  if (constraints.injuryLimited) {
    const avoidLongRun = /长距离|跑量|距离/.test(constraints.injuryNotes || "");
    for (const day of days) {
      if (/间歇|法特莱克|坡|节奏/.test(day.training)) {
        Object.assign(day, {
          training: "轻松跑",
          volume: "25–35 分钟",
          effort: "可完整说话",
          purpose: "伤病限制：取消高强度课程，保持轻松有氧"
        });
        notes.push(`${weekdayLabel(weekdayOfDate(day.date))}的质量课已按伤病限制降级`);
      } else if (avoidLongRun && /长距离/.test(day.training)) {
        Object.assign(day, {
          training: "轻松跑",
          volume: "40–50 分钟",
          effort: "可完整说话",
          purpose: "伤病限制：缩短长距离，避免高负荷"
        });
        notes.push(`${weekdayLabel(weekdayOfDate(day.date))}的长距离已按伤病限制缩短`);
      }
    }
  }

  const applied = {
    ...constraints,
    notes,
    constraintLines: [...constraintLines(constraints), ...notes]
  };
  return { ...plan, days, constraints: applied, constraintLines: applied.constraintLines };
}
