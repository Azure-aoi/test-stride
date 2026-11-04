import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHeartRateProfile,
  calculateDashboard,
  formatPace,
  metricsForWindow,
  resolveAnalysisWindow
} from "../src/metrics.js";

const now = new Date("2026-11-02T08:00:00+08:00");

function run(daysAgo, distanceM, durationSec, hr) {
  return {
    startedAt: new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    distanceM,
    durationSec,
    avgHeartRate: hr,
    trainingLoad: 50
  };
}

test("metricsForWindow calculates weighted pace and totals", () => {
  const metrics = metricsForWindow([run(1, 10000, 3200, 150), run(2, 5000, 1800, 140)]);
  assert.equal(metrics.distanceKm, 15);
  assert.equal(metrics.runCount, 2);
  assert.equal(metrics.avgPaceSecPerKm, 333);
  assert.equal(metrics.avgHeartRate, 145);
});

test("calculateDashboard separates current and previous periods", () => {
  const dashboard = calculateDashboard(
    [run(2, 10000, 3200, 150), run(35, 5000, 1800, 145)],
    28,
    now
  );
  assert.equal(dashboard.current.runCount, 1);
  assert.equal(dashboard.previous.runCount, 1);
  assert.equal(dashboard.current.distanceKm, 10);
});

test("treats equal current and previous load as stable readiness", () => {
  const dashboard = calculateDashboard(
    [run(2, 10000, 3200, 150), run(5, 10000, 3200, 150), run(35, 10000, 3200, 150), run(40, 10000, 3200, 150)],
    28,
    now
  );
  assert.equal(dashboard.readiness.loadRatio, 1);
  assert.notEqual(dashboard.readiness.label, "负荷偏高");
});

test("high heart rate does not change the training readiness label", () => {
  const lowHr = calculateDashboard(
    [
      run(2, 10000, 3200, 140),
      run(5, 10000, 3200, 140),
      run(35, 10000, 3200, 140),
      run(40, 10000, 3200, 140)
    ],
    28,
    now
  );
  const highHr = calculateDashboard(
    [
      run(2, 10000, 3200, 190),
      run(5, 10000, 3200, 190),
      run(35, 10000, 3200, 190),
      run(40, 10000, 3200, 190)
    ],
    28,
    now
  );
  assert.equal(highHr.readiness.label, lowHr.readiness.label);
});

test("uses volume and frequency as a readiness proxy when training load is missing", () => {
  const noLoad = (activity) => ({ ...activity, trainingLoad: 0 });
  const dashboard = calculateDashboard(
    [
      noLoad(run(2, 30000, 9600, 150)),
      noLoad(run(5, 30000, 9600, 150)),
      noLoad(run(35, 10000, 3200, 150))
    ],
    28,
    now
  );
  assert.equal(dashboard.readiness.loadSource, "volume-proxy");
  assert.equal(dashboard.readiness.label, "负荷偏高");
  assert.ok(dashboard.readiness.loadRatio > 1.35);
});

test("builds an advisory-only personal heart-rate profile", () => {
  const profile = buildHeartRateProfile([
    run(1, 10000, 3200, 150),
    run(3, 10000, 3200, 160),
    run(5, 10000, 3200, 170),
    run(7, 10000, 3200, 180)
  ]);
  assert.equal(profile.available, true);
  assert.equal(profile.sampleCount, 4);
  assert.equal(profile.medianBpm, 165);
  assert.equal(profile.usage, "advisory-only");
  assert.match(profile.guidance, /不参与计划/);
});

test("groups same-day segments and weights heart rate by duration", () => {
  const profile = buildHeartRateProfile([
    {
      ...run(1, 1000, 300, 140),
      startedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    },
    {
      ...run(1, 3000, 1800, 180),
      startedAt: new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString()
    },
    run(3, 10000, 3200, 150),
    run(5, 10000, 3200, 160)
  ]);
  assert.equal(profile.sampleCount, 3);
  assert.equal(profile.activityCount, 4);
  assert.equal(profile.recentMedianBpm, 160);
  assert.ok(profile.medianBpm >= 150 && profile.medianBpm <= 180);
});

test("formatPace renders minutes and seconds", () => {
  assert.equal(formatPace(331), "5:31");
  assert.equal(formatPace(null), "--");
});

test("analysis window falls back to the latest historical activity", () => {
  const activities = [run(35, 5000, 1680, 145)];
  const window = resolveAnalysisWindow(activities, 28, now);
  assert.equal(window.isHistorical, true);
  const dashboard = calculateDashboard(activities, 28, window.anchor);
  assert.equal(dashboard.current.runCount, 1);
});
