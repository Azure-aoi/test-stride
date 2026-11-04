import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "stride-agent-api-test-"));
process.env.DB_PATH = path.join(tempDir, "agent.db");
process.env.SEED_DEMO = "false";

const store = await import("../src/agent-store.js");
const { registerAgentRoutes } = await import("../src/agent-api.js");

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
registerAgentRoutes(app, { asyncRoute, httpError });
app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  response.status(error.status || 500).json({
    error: {
      code: error.code || "INTERNAL_ERROR",
      message: error.message
    }
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

test("rejects unsupported memory types through the API", async () => {
  const response = await fetch(`${baseUrl}/api/memory`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "unsupported",
      content: "这条记忆不应保存"
    })
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, "MEMORY_TYPE_INVALID");
});

test("does not retry a completed run", async () => {
  const session = store.createSession("API 重试限制测试");
  store.createAgentRun({
    id: "completed-retry-run",
    sessionId: session.id,
    question: "已经完成的问题",
    modelLabel: "本地分析",
    model: {},
    promptVersion: null,
    context: {}
  });
  store.updateAgentRun("completed-retry-run", {
    status: "completed",
    stage: "completed",
    answer: "已经完成",
    endedAt: new Date().toISOString()
  });
  const response = await fetch(
    `${baseUrl}/api/agent/runs/completed-retry-run/retry`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.error.code, "RUN_NOT_RETRYABLE");
});
