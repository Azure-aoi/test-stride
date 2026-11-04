import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "stride-tool-schema-"));
process.env.DB_PATH = path.join(tempDir, "schema.db");
process.env.SEED_DEMO = "true";

const { executeAgentTool } = await import("../src/agent-tools.js");

test("rejects unknown tools", async () => {
  await assert.rejects(executeAgentTool("notATool", {}), /未知工具/);
});

test("rejects non-object arguments", async () => {
  await assert.rejects(executeAgentTool("getRunnerProfile", []), /JSON 对象/);
});

test("rejects arguments that miss a required field", async () => {
  await assert.rejects(executeAgentTool("searchMemories", {}), /缺少必填参数 query/);
});

test("rejects arguments with the wrong type", async () => {
  await assert.rejects(
    executeAgentTool("searchMemories", { query: 42 }),
    /query 应为 string/
  );
});

test("rejects values outside an enum", async () => {
  await assert.rejects(
    executeAgentTool("getTrainingMetrics", { days: 14 }),
    /days 必须是 7、28、56、90 之一/
  );
});

test("rejects values outside numeric bounds", async () => {
  await assert.rejects(
    executeAgentTool("getRecentActivities", { limit: 60 }),
    /limit 不能大于 30/
  );
});

test("rejects unknown properties", async () => {
  await assert.rejects(
    executeAgentTool("getRecentActivities", { limit: 5, foo: 1 }),
    /不支持参数 foo/
  );
});

test("marks validation errors so the model can retry", async () => {
  await assert.rejects(executeAgentTool("searchMemories", {}), (error) => {
    assert.equal(error.code, "TOOL_ARGUMENTS_INVALID");
    assert.ok(error.details.length > 0);
    return true;
  });
});

test("propagates cancellation into tool execution", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeAgentTool("getRunnerProfile", {}, { signal: controller.signal }),
    (error) => error.code === "RUN_CANCELLED"
  );
});

test("executes tools with valid arguments", async () => {
  const result = await executeAgentTool("getRecentActivities", { limit: 3 });
  assert.ok(Array.isArray(result.activities));
  assert.ok(result.activities.length <= 3);
});
