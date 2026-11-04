const DEMO_RUNS = [
  { daysAgo: 2, hour: 7, distanceKm: 12.4, pace: 318, hr: 154, maxHr: 176, cadence: 176, load: 94, title: "河岸耐力跑" },
  { daysAgo: 4, hour: 19, distanceKm: 6.2, pace: 329, hr: 146, maxHr: 163, cadence: 173, load: 52, title: "下班恢复跑" },
  { daysAgo: 7, hour: 7, distanceKm: 10.0, pace: 322, hr: 151, maxHr: 172, cadence: 175, load: 78, title: "10K 节奏跑" },
  { daysAgo: 9, hour: 18, distanceKm: 5.0, pace: 342, hr: 139, maxHr: 155, cadence: 170, load: 36, title: "公园轻松跑" },
  { daysAgo: 12, hour: 7, distanceKm: 16.1, pace: 336, hr: 148, maxHr: 171, cadence: 172, load: 108, title: "周末长距离" },
  { daysAgo: 15, hour: 20, distanceKm: 8.0, pace: 327, hr: 150, maxHr: 168, cadence: 174, load: 62, title: "渐进跑" },
  { daysAgo: 18, hour: 7, distanceKm: 7.3, pace: 334, hr: 145, maxHr: 162, cadence: 172, load: 54, title: "晨间有氧跑" },
  { daysAgo: 21, hour: 18, distanceKm: 12.0, pace: 330, hr: 149, maxHr: 169, cadence: 173, load: 86, title: "中长距离" },
  { daysAgo: 24, hour: 7, distanceKm: 5.4, pace: 347, hr: 137, maxHr: 151, cadence: 169, load: 34, title: "恢复慢跑" },
  { daysAgo: 28, hour: 20, distanceKm: 8.8, pace: 338, hr: 146, maxHr: 165, cadence: 171, load: 61, title: "夜间轻松跑" },
  { daysAgo: 32, hour: 7, distanceKm: 14.2, pace: 344, hr: 147, maxHr: 168, cadence: 170, load: 90, title: "周末耐力跑" },
  { daysAgo: 37, hour: 19, distanceKm: 6.0, pace: 350, hr: 142, maxHr: 158, cadence: 169, load: 38, title: "下班慢跑" },
  { daysAgo: 42, hour: 7, distanceKm: 10.0, pace: 348, hr: 148, maxHr: 166, cadence: 169, load: 70, title: "10K 有氧跑" },
  { daysAgo: 49, hour: 18, distanceKm: 5.0, pace: 356, hr: 140, maxHr: 154, cadence: 168, load: 31, title: "恢复跑" }
];

function startedAt(daysAgo, hour) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 10, 0, 0);
  return date.toISOString();
}

export function buildDemoActivities() {
  return DEMO_RUNS.map((run, index) => ({
    provider: "demo",
    externalId: `demo-run-${index + 1}`,
    startedAt: startedAt(run.daysAgo, run.hour),
    durationSec: Math.round(run.distanceKm * run.pace),
    distanceM: Math.round(run.distanceKm * 1000),
    avgPaceSecPerKm: run.pace,
    avgHeartRate: run.hr,
    maxHeartRate: run.maxHr,
    cadence: run.cadence,
    elevationGainM: 18 + ((index * 11) % 48),
    trainingLoad: run.load,
    raw: {
      title: run.title,
      note: "用于产品演示的本地样例数据"
    }
  }));
}
