const DAY_MS = 24 * 60 * 60 * 1000;

function round(value, digits = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round((sortedValues.length - 1) * ratio))
  );
  return sortedValues[index];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function startOfWeek(date) {
  const result = new Date(date);
  const day = result.getDay();
  const distanceToMonday = day === 0 ? 6 : day - 1;
  result.setDate(result.getDate() - distanceToMonday);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function metricsForWindow(activities) {
  const distanceM = activities.reduce((sum, item) => sum + item.distanceM, 0);
  const durationSec = activities.reduce((sum, item) => sum + item.durationSec, 0);
  const heartRates = activities
    .map((item) => item.avgHeartRate)
    .filter((value) => Number.isFinite(value) && value > 0);
  const load = activities.reduce((sum, item) => sum + (item.trainingLoad || 0), 0);
  const longest = activities.reduce(
    (max, item) => (item.distanceM > max ? item.distanceM : max),
    0
  );

  return {
    runCount: activities.length,
    distanceKm: round(distanceM / 1000, 1),
    durationSec,
    avgPaceSecPerKm: distanceM > 0 ? round(durationSec / (distanceM / 1000)) : null,
    avgHeartRate: heartRates.length
      ? round(heartRates.reduce((sum, value) => sum + value, 0) / heartRates.length)
      : null,
    trainingLoad: round(load),
    longestRunKm: round(longest / 1000, 1)
  };
}

export function buildHeartRateProfile(activities, { maxRuns = 30 } = {}) {
  const validActivities = [...activities]
    .filter((item) => {
      const value = Number(item.avgHeartRate);
      return (
        Number.isFinite(value) &&
        value >= 60 &&
        value <= 240 &&
        Number.isFinite(new Date(item.startedAt).getTime())
      );
    })
    .sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  const byTrainingDay = new Map();
  for (const activity of validActivities) {
    const timestamp = new Date(activity.startedAt).getTime();
    const dateKey = new Date(timestamp + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const weight = Math.max(1, Number(activity.durationSec) || 1);
    const group = byTrainingDay.get(dateKey) || {
      date: dateKey,
      latestAt: timestamp,
      activityCount: 0,
      durationWeight: 0,
      weightedHeartRate: 0
    };
    group.latestAt = Math.max(group.latestAt, timestamp);
    group.activityCount += 1;
    group.durationWeight += weight;
    group.weightedHeartRate += Number(activity.avgHeartRate) * weight;
    byTrainingDay.set(dateKey, group);
  }
  const samples = [...byTrainingDay.values()]
    .sort((a, b) => b.latestAt - a.latestAt)
    .slice(0, Math.max(1, maxRuns))
    .map((group) => ({
      ...group,
      avgHeartRate: group.weightedHeartRate / group.durationWeight
    }));
  const activityCount = samples.reduce(
    (sum, sample) => sum + sample.activityCount,
    0
  );
  const values = samples.map((item) => Number(item.avgHeartRate));
  const sorted = [...values].sort((a, b) => a - b);

  if (!values.length) {
    return {
      available: false,
      sampleCount: 0,
      activityCount: 0,
      usage: "advisory-only",
      guidance:
        "暂无足够心率记录。心率仅用于训练过程建议，不作为计划难度、强度次数或跑量决策依据。"
    };
  }

  const recentCount = Math.min(5, values.length);
  const recentValues = values.slice(0, recentCount);
  const baselineValues = values.slice(recentCount);
  const recentMedianBpm = round(median(recentValues));
  const baselineMedianBpm = baselineValues.length
    ? round(median(baselineValues))
    : round(median(values));
  const changeBpm =
    Number.isFinite(recentMedianBpm) && Number.isFinite(baselineMedianBpm)
      ? round(recentMedianBpm - baselineMedianBpm)
      : null;
  const available = values.length >= 3;
  const trendAdvice =
    available && Math.abs(changeBpm || 0) >= 8
      ? `近期训练心率中位数比更早记录${
          changeBpm > 0 ? "高" : "低"
        } ${Math.abs(changeBpm)} bpm，可在强度课开始阶段多观察主观状态。`
      : "近期心率与个人历史区间基本接近。";

  return {
    available,
    sampleCount: values.length,
    activityCount,
    usage: "advisory-only",
    averageBpm: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    medianBpm: round(median(values)),
    typicalLowBpm: percentile(sorted, 0.25),
    typicalHighBpm: percentile(sorted, 0.75),
    minBpm: sorted[0],
    maxBpm: sorted.at(-1),
    recentMedianBpm,
    baselineMedianBpm,
    changeBpm,
    guidance: available
      ? `已基于最近 ${values.length} 个训练日、共 ${activityCount} 条跑步记录建立个人心率档案。该档案只用于过程建议，不参与计划难度、强度次数或跑量决策。${trendAdvice}`
      : "有效心率训练日少于 3 天，暂不形成稳定个人档案；心率仍不作为训练计划决策依据。"
  };
}

function percentageChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return round(((current - previous) / previous) * 100, 1);
}

function weeklyTrend(activities, now, weeks = 8) {
  const currentWeek = startOfWeek(now);
  const buckets = [];

  for (let index = weeks - 1; index >= 0; index -= 1) {
    const start = new Date(currentWeek);
    start.setDate(start.getDate() - index * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    buckets.push({ start, end, activities: [] });
  }

  for (const activity of activities) {
    const date = new Date(activity.startedAt);
    const bucket = buckets.find((item) => date >= item.start && date < item.end);
    if (bucket) bucket.activities.push(activity);
  }

  return buckets.map((bucket) => {
    const metrics = metricsForWindow(bucket.activities);
    return {
      label: `${bucket.start.getMonth() + 1}/${bucket.start.getDate()}`,
      distanceKm: metrics.distanceKm,
      paceSecPerKm: metrics.avgPaceSecPerKm,
      load: metrics.trainingLoad,
      runs: metrics.runCount
    };
  });
}

function readiness(metrics, previous) {
  if (!metrics.runCount) {
    return {
      score: 0,
      label: "等待数据",
      note: "导入跑步记录后生成训练节奏评估。",
      loadRatio: null
    };
  }

  const weeklyLoad = metrics.trainingLoad || 0;
  const previousWeeklyLoad = previous.trainingLoad || 0;
  let loadRatio = 1;
  let loadSource = "insufficient-history";
  if (weeklyLoad > 0 && previousWeeklyLoad > 0) {
    loadRatio = weeklyLoad / previousWeeklyLoad;
    loadSource = "training-load";
  } else if (previous.distanceKm > 0) {
    const volumeRatio = metrics.distanceKm / previous.distanceKm;
    const frequencyRatio =
      previous.runCount > 0 ? metrics.runCount / previous.runCount : 1;
    loadRatio = volumeRatio * 0.75 + frequencyRatio * 0.25;
    loadSource = "volume-proxy";
  }
  const loadPenalty = loadRatio > 1.35 ? 18 : loadRatio < 0.65 ? 9 : 0;
  const score = Math.max(
    35,
    Math.min(
      96,
      Math.round(84 + 8 * Math.min(loadRatio, 1) - loadPenalty)
    )
  );

  let label = "节奏平稳";
  let note = "近期训练量处于可控区间，可以维持当前节奏。";
  if (loadRatio > 1.35) {
    label = "负荷偏高";
    note =
      loadSource === "volume-proxy"
        ? "近期跑量和训练频率增长较快，建议控制新增跑量并观察恢复状态。"
        : "近期负荷增长较快，建议控制新增跑量并观察恢复状态。";
  } else if (loadRatio < 0.65) {
    label = "恢复窗口";
    note = "近期训练量低于前一周期，适合逐步恢复。";
  }

  return {
    score,
    label,
    note,
    loadRatio: round(loadRatio, 2),
    loadSource
  };
}

export function calculateDashboard(activities, days = 28, now = new Date()) {
  const currentStart = new Date(now.getTime() - days * DAY_MS);
  const previousStart = new Date(now.getTime() - days * 2 * DAY_MS);
  const sorted = [...activities].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
  const current = sorted.filter((item) => new Date(item.startedAt) >= currentStart);
  const previous = sorted.filter((item) => {
    const date = new Date(item.startedAt);
    return date >= previousStart && date < currentStart;
  });
  const currentMetrics = metricsForWindow(current);
  const previousMetrics = metricsForWindow(previous);
  const heartRateProfile = buildHeartRateProfile(current);

  return {
    days,
    generatedAt: now.toISOString(),
    current: currentMetrics,
    previous: previousMetrics,
    changes: {
      distancePct: percentageChange(currentMetrics.distanceKm, previousMetrics.distanceKm),
      pacePct:
        currentMetrics.avgPaceSecPerKm && previousMetrics.avgPaceSecPerKm
          ? percentageChange(currentMetrics.avgPaceSecPerKm, previousMetrics.avgPaceSecPerKm)
          : null,
      heartRatePct: percentageChange(currentMetrics.avgHeartRate, previousMetrics.avgHeartRate)
    },
    readiness: readiness(currentMetrics, previousMetrics),
    heartRateProfile,
    weekTrend: weeklyTrend(activities, now, 8),
    latestRun: sorted[0] || null
  };
}

export function resolveAnalysisWindow(activities, days = 28, now = new Date()) {
  const latest = activities.reduce((result, activity) => {
    const date = new Date(activity.startedAt);
    return !result || date > result ? date : result;
  }, null);
  if (!latest) {
    return { anchor: now, isHistorical: false, latest: null };
  }
  const recentStart = new Date(now.getTime() - days * DAY_MS);
  const isHistorical = latest < recentStart;
  return {
    anchor: isHistorical ? latest : now,
    isHistorical,
    latest
  };
}

export function formatPace(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainder}`;
}
