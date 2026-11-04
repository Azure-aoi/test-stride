import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCorosToolRecords,
  isRunningCorosRecord,
  normalizeCorosRecord
} from "../src/coros.js";

test("extracts COROS structured activity records", () => {
  const result = {
    structuredContent: {
      records: [
        {
          labelId: "123456",
          sportType: 100,
          startTime: "2026-11-01T07:00:00+08:00",
          duration: 3120,
          distanceKm: 10,
          avgPace: "5:12",
          avgHr: 156,
          maxHr: 178,
          avgCadence: 176
        }
      ]
    }
  };
  const records = extractCorosToolRecords(result);
  assert.equal(records.length, 1);
  const activity = normalizeCorosRecord(records[0]);
  assert.equal(activity.externalId, "coros:123456");
  assert.equal(activity.distanceM, 10000);
  assert.equal(activity.avgPaceSecPerKm, 312);
  assert.equal(activity.avgHeartRate, 156);
});

test("parses COROS formatted text activity output", () => {
  const result = {
    content: [
      {
        type: "text",
        text: [
          "Sport Records — 2026-09-19 to 2026-10-18 (1 records)",
          "",
          "1. Sport(9807) — 2026-10-03",
          "   Duration: 2:12:38 | Distance: 12.03 km",
          "   Average Pace: 11:01 /km"
        ].join("\n")
      }
    ]
  };
  const records = extractCorosToolRecords(result);
  assert.equal(records.length, 1);
  const activity = normalizeCorosRecord(records[0]);
  assert.equal(activity.durationSec, 7958);
  assert.equal(activity.distanceM, 12030);
  assert.equal(activity.avgPaceSecPerKm, 661);
});

test("recognizes running sport types and rejects other activities", () => {
  const base = {
    startTime: "2026-11-01T07:00:00+08:00",
    duration: 1800,
    distanceKm: 5
  };
  assert.equal(isRunningCorosRecord({ ...base, sportType: 100 }), true);
  assert.equal(isRunningCorosRecord({ ...base, sportType: 102 }), true);
  assert.equal(isRunningCorosRecord({ ...base, sportType: 200 }), false);
  assert.equal(isRunningCorosRecord({ ...base, sportType: 300 }), false);
  assert.equal(isRunningCorosRecord({ ...base, sportType: 9807 }), false);
  assert.equal(isRunningCorosRecord({ ...base, sportName: "Outdoor Walk" }), false);
  assert.equal(isRunningCorosRecord({ ...base, sportName: "越野跑" }), true);
});

test("parses date-only COROS records as China local time", () => {
  const activity = normalizeCorosRecord({
    sportType: 100,
    startTime: "2026-10-03",
    duration: 1800,
    distanceKm: 5
  });
  assert.equal(activity.startedAt, "2026-10-02T23:00:00.000Z");
});

test("parses naive COROS datetimes as China local time", () => {
  const activity = normalizeCorosRecord({
    sportType: 100,
    startTime: "2026-10-03 07:30:00",
    duration: 1800,
    distanceKm: 5
  });
  assert.equal(activity.startedAt, "2026-10-02T23:30:00.000Z");
});

test("parses COROS text wrapped in a JSON string with activity metadata", () => {
  const formatted = [
    "Sport Records — 2026-10-03 to 2026-11-02 (3 records)",
    "",
    "1. Outdoor Run — 2026-10-31",
    "   Location: 珠海市",
    "   Time Window: startTimestamp=1793449473 | endTimestamp=1793451037",
    "   Duration: 23:26 | Distance: 5.01 km",
    "   Average Pace: 4:41 /km | Avg HR: 174 bpm | Calories: 305 kcal",
    "   LabelId: 481466798682702325 | SportType: 100",
    "",
    "2. Outdoor Run — 2026-10-31",
    "   Location: 珠海市",
    "   Time Window: startTimestamp=1793447735 | endTimestamp=1793449202",
    "   Duration: 23:44 | Distance: 5.01 km",
    "   Average Pace: 4:44 /km | Avg HR: 170 bpm | Calories: 304 kcal",
    "   LabelId: 481468540023504903 | SportType: 100",
    "",
    "3. Outdoor Run — 2026-10-30",
    "   Location: 珠海市",
    "   Time Window: startTimestamp=1793361943 | endTimestamp=1793367049",
    "   Duration: 1:05:07 | Distance: 12.02 km",
    "   Average Pace: 5:25 /km | Avg HR: 160 bpm | Calories: 748 kcal",
    "   LabelId: 481468543779504729 | SportType: 100"
  ].join("\n");
  const records = extractCorosToolRecords({
    content: [{ type: "text", text: JSON.stringify(JSON.stringify(formatted)) }]
  });
  assert.equal(records.length, 3);
  assert.equal(records[0].labelId, "481466798682702325");
  assert.equal(records[0].sportType, 100);
  const activity = normalizeCorosRecord(records[0]);
  assert.equal(activity.startedAt, "2026-10-31T12:24:33.000Z");
  assert.equal(activity.distanceM, 5010);
  assert.equal(activity.avgPaceSecPerKm, 281);
  assert.equal(activity.avgHeartRate, 174);
  assert.equal(activity.externalId, "coros:481466798682702325");
});
