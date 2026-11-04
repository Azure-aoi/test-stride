import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseTrainingTemplate,
  formatSevenDayPlan,
  generateSevenDayPlan
} from "../src/training-plan.js";
import { buildSystemPrompt } from "../src/coach.js";
import { buildPlanConstraints } from "../src/plan-constraints.js";

function dashboard({
  runCount = 3,
  distanceKm = 24,
  avgHeartRate = 148
} = {}) {
  return {
    days: 28,
    current: {
      runCount,
      distanceKm,
      avgHeartRate,
      avgPaceSecPerKm: 330
    },
    changes: { distancePct: 5 },
    readiness: { label: "节奏平稳" }
  };
}

test("does not use high heart rate to change the training template", () => {
  assert.equal(
    chooseTrainingTemplate(dashboard({ avgHeartRate: 190, distanceKm: 100 }), {
      startDate: "2026-11-02",
      goalDate: "2027-01-15"
    }),
    "build"
  );
});

test("chooses base building when recent volume is low", () => {
  assert.equal(
    chooseTrainingTemplate(dashboard({ runCount: 1, distanceKm: 5 })),
    "base"
  );
});

test("generates exactly seven executable days", () => {
  const plan = generateSevenDayPlan(
    dashboard(),
    new Date("2026-11-02T08:00:00+08:00")
  );
  assert.equal(plan.days.length, 7);
  assert.match(formatSevenDayPlan(plan), /调整条件/);
});

test("schedules at least two quality sessions more than 30 days before a race", () => {
  const plan = generateSevenDayPlan(dashboard(), {
    startDate: "2026-11-02",
    constraints: {
      goalDate: "2027-01-15",
      goalPaceLabel: "4:59"
    }
  });
  assert.ok(plan.daysToRace > 30);
  assert.ok(plan.intensitySessionCount >= 2);
  assert.match(formatSevenDayPlan(plan), /心率未参与计划难度和强度数量决策/);
});

test("switches to race pace and long runs within 30 days of a race", () => {
  const plan = generateSevenDayPlan(dashboard(), {
    startDate: "2026-11-02",
    constraints: {
      goalDate: "2026-11-20",
      goalPaceLabel: "4:59"
    }
  });
  assert.equal(plan.key, "race");
  assert.ok(plan.intensitySessionCount >= 2);
  assert.ok(plan.days.some((day) => day.training.includes("比赛配速")));
  assert.ok(plan.days.some((day) => day.training.includes("长距离")));
  assert.ok(!plan.days.some((day) => day.training.includes("短间歇")));
});

test("keeps plan dates aligned with the requested start date", () => {
  const plan = generateSevenDayPlan(dashboard(), { startDate: "2026-11-02" });
  assert.equal(plan.startDate, "2026-11-02");
  assert.equal(plan.days[0].date, "2026-11-02");
  assert.equal(plan.days.at(-1).date, "2026-11-08");
});

test("moves training off weekdays blocked by long-term memory", () => {
  const constraints = buildPlanConstraints({
    memories: [{ type: "preference", content: "周一没空" }],
    startDate: "2026-11-02"
  });
  const plan = generateSevenDayPlan(dashboard({ distanceKm: 112 }), {
    startDate: "2026-11-02",
    constraints
  });
  assert.equal(plan.days[0].training, "休息");
  assert.ok(plan.constraintLines.some((line) => line.includes("周一")));
});

test("recognizes runner language that says they cannot run", () => {
  const constraints = buildPlanConstraints({
    memories: [{ type: "preference", content: "周一我跑不了" }],
    startDate: "2026-11-02"
  });
  assert.ok(constraints.unavailableWeekdays.includes(1));
});

test("uses the goal time to calculate race pace", () => {
  const constraints = buildPlanConstraints({
    profile: {
      goalRace: "珠海马拉松",
      goalDate: "2026-12-23",
      targetTime: "3:30:00"
    },
    startDate: "2026-11-02"
  });
  assert.equal(constraints.goalPaceLabel, "4:59");
  assert.ok(constraints.constraintLines.some((line) => line.includes("目标配速")));
});

test("calculates goal pace for a 10K target", () => {
  const constraints = buildPlanConstraints({
    profile: {
      goalRace: "城市 10K",
      goalDate: "2026-12-23",
      targetTime: "47:00"
    },
    startDate: "2026-11-02"
  });
  assert.equal(constraints.goalDistanceKm, 10);
  assert.equal(constraints.goalPaceLabel, "4:42");
});

test("honors available weekdays from the runner profile", () => {
  const constraints = buildPlanConstraints({
    profile: { availableDays: "周二、周四、周六" },
    startDate: "2026-11-02"
  });
  const plan = generateSevenDayPlan(dashboard({ distanceKm: 112 }), {
    startDate: "2026-11-02",
    constraints
  });
  assert.equal(plan.days[0].training, "休息");
  assert.notEqual(plan.days[1].training, "休息");
  assert.equal(plan.days[2].training, "休息");
  assert.equal(plan.days[4].training, "休息");
});

test("model system prompt loads the saved elite coach skill", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /吴向东/);
  assert.match(prompt, /萨巴斯蒂安·萨维/);
  assert.match(prompt, /不得照搬/);
  assert.match(prompt, /禁止根据平均心率/);
  assert.match(prompt, /至少安排两次/);
});
