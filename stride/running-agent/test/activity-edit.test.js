import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "stride-activity-edit-test-"));
process.env.DB_PATH = path.join(tempDir, "activity-edit.db");
process.env.SEED_DEMO = "false";

const db = await import("../src/db.js");
const { registerDataRoutes } = await import("../src/api/data-routes.js");

db.saveActivities(
  [
    {
      provider: "upload",
      externalId: "activity-edit-test",
      startedAt: "2026-11-04T07:30:00+08:00",
      durationSec: 1800,
      distanceM: 5000,
      avgPaceSecPerKm: 360,
      avgHeartRate: 150,
      raw: { filename: "activity-edit.csv" }
    }
  ],
  null
);

const activityId = db.listActivities({ limit: 1 })[0].id;
const app = express();
app.use(express.json());
const asyncRoute = (handler) => (request, response, next) =>
  Promise.resolve(handler(request, response, next)).catch(next);
const httpError = (status, code, message) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};
registerDataRoutes(app, {
  asyncRoute,
  httpError,
  upload: { single: () => (request, response, next) => next() }
});
app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  response.status(error.status || 500).json({
    error: { code: error.code || "INTERNAL_ERROR", message: error.message }
  });
});
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

after(
  () =>
    new Promise((resolve) => {
      server.close(resolve);
    })
);

test("renames and deletes a single activity through the API", async () => {
  const renameResponse = await fetch(`${baseUrl}/api/activities/${activityId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "周四节奏跑" })
  });
  assert.equal(renameResponse.status, 200);
  const renamed = await renameResponse.json();
  assert.equal(renamed.activity.raw.title, "周四节奏跑");
  assert.equal(db.getActivity(activityId).raw.title, "周四节奏跑");

  const deleteResponse = await fetch(`${baseUrl}/api/activities/${activityId}`, {
    method: "DELETE"
  });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { deleted: true });
  assert.equal(db.getActivity(activityId), null);
});

test("rejects an empty activity name", async () => {
  const response = await fetch(`${baseUrl}/api/activities/unknown`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "   " })
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, "ACTIVITY_TITLE_REQUIRED");
});
