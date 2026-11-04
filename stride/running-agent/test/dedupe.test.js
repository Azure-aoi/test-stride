import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "stride-dedupe-test-"));
process.env.DB_PATH = path.join(tempDir, "dedupe.db");
process.env.SEED_DEMO = "false";

const { listActivities, saveActivities } = await import("../src/db.js");

function run(overrides = {}) {
  return {
    provider: "coros",
    externalId: "coros:1",
    startedAt: "2026-10-01T00:00:00.000Z",
    durationSec: 3600,
    distanceM: 10000,
    ...overrides
  };
}

test("deduplicates the same run imported from another source", () => {
  assert.equal(saveActivities([run()]).inserted, 1);
  const duplicate = saveActivities([
    run({
      provider: "upload",
      externalId: "upload:1",
      startedAt: "2026-10-01T00:01:00.000Z",
      durationSec: 3618,
      distanceM: 10060
    })
  ]);
  assert.equal(duplicate.inserted, 0);
  assert.equal(duplicate.crossSourceSkipped, 1);
  assert.equal(listActivities().length, 1);
});

test("keeps runs that are clearly distinct", () => {
  const result = saveActivities([
    run({
      externalId: "coros:2",
      startedAt: "2026-10-02T00:00:00.000Z"
    }),
    run({
      provider: "upload",
      externalId: "upload:2",
      startedAt: "2026-10-02T00:10:00.000Z"
    })
  ]);
  assert.equal(result.inserted, 2);
});

test("demo activities do not block real imports", () => {
  saveActivities([
    run({
      provider: "demo",
      externalId: "demo:1",
      startedAt: "2026-10-03T00:00:00.000Z"
    })
  ]);
  const result = saveActivities([
    run({
      provider: "upload",
      externalId: "upload:3",
      startedAt: "2026-10-03T00:00:00.000Z"
    })
  ]);
  assert.equal(result.inserted, 1);
});

test("still skips exact duplicates within the same provider", () => {
  const before = listActivities().length;
  const result = saveActivities([run({ externalId: "coros:1" })]);
  assert.equal(result.inserted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(listActivities().length, before);
});
