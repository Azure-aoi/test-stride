import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "stride-workspace-test-"));
process.env.DB_PATH = path.join(tempDir, "workspace.db");
process.env.SEED_DEMO = "false";

const {
  db,
  currentUserId,
  listActivities,
  runAsUser,
  saveActivities
} = await import("../src/db.js");
const { ensureUserSession, listSessions } = await import("../src/agent-store.js");
const { workspaceMiddleware } = await import("../src/workspace.js");

const app = express();
app.use(workspaceMiddleware);
app.get("/api/whoami", (request, response) => {
  response.json({ userId: currentUserId() });
});
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("isolates activities by browser workspace", () => {
  runAsUser("guest-a", () => {
    saveActivities([
      {
        provider: "upload",
        externalId: "workspace-a-run",
        startedAt: "2026-11-04T07:30:00+08:00",
        durationSec: 1800,
        distanceM: 5000
      }
    ]);
  });

  assert.equal(runAsUser("guest-a", () => listActivities().length), 1);
  assert.equal(runAsUser("guest-b", () => listActivities().length), 0);
});

test("creates a separate default session for each workspace", () => {
  const first = runAsUser("guest-session-a", () => {
    ensureUserSession();
    return listSessions()[0].id;
  });
  const second = runAsUser("guest-session-b", () => {
    ensureUserSession();
    return listSessions()[0].id;
  });

  assert.notEqual(first, second);
});

test("keeps one workspace per browser session", async () => {
  const first = await fetch(`${baseUrl}/api/whoami`);
  const firstPayload = await first.json();
  const cookie = first.headers.get("set-cookie").split(";")[0];
  assert.match(firstPayload.userId, /^guest-/);
  assert.match(first.headers.get("set-cookie"), /SameSite=Lax/);

  const sameSession = await fetch(`${baseUrl}/api/whoami`, {
    headers: { cookie }
  });
  assert.equal((await sameSession.json()).userId, firstPayload.userId);

  const newSession = await fetch(`${baseUrl}/api/whoami`);
  assert.notEqual((await newSession.json()).userId, firstPayload.userId);
});
