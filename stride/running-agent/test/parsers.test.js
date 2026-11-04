import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseGpx } from "../src/parsers.js";

test("parseCsv normalizes a valid run", () => {
  const buffer = Buffer.from(
    [
      "started_at,distance_km,duration_sec,avg_heart_rate,notes",
      "2026-11-01T07:30:00+08:00,10,3120,156,测试跑"
    ].join("\n")
  );
  const result = parseCsv(buffer, "test.csv");
  assert.equal(result.errors.length, 0);
  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].distanceM, 10000);
  assert.equal(result.activities[0].avgPaceSecPerKm, 312);
  assert.match(result.activities[0].externalId, /^upload:/);
});

test("parseCsv reports rows without distance", () => {
  const buffer = Buffer.from(
    ["started_at,distance_km,duration_sec", "2026-11-01T07:30:00+08:00,,3120"].join("\n")
  );
  const result = parseCsv(buffer);
  assert.equal(result.activities.length, 0);
  assert.equal(result.errors[0].line, 2);
});

test("parseGpx derives distance from track points", () => {
  const buffer = Buffer.from(`
    <gpx>
      <trk><trkseg>
        <trkpt lat="31.2300" lon="121.4700"><time>2026-11-01T07:00:00Z</time></trkpt>
        <trkpt lat="31.2310" lon="121.4710"><time>2026-11-01T07:05:00Z</time></trkpt>
        <trkpt lat="31.2320" lon="121.4720"><time>2026-11-01T07:10:00Z</time></trkpt>
      </trkseg></trk>
    </gpx>
  `);
  const result = parseGpx(buffer, "test.gpx");
  assert.equal(result.errors.length, 0);
  assert.equal(result.activities.length, 1);
  assert.ok(result.activities[0].distanceM > 200);
  assert.equal(result.activities[0].durationSec, 600);
});
