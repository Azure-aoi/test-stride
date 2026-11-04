import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "stride-memory-test-"));
process.env.DB_PATH = path.join(tempDir, "memory.db");
process.env.SEED_DEMO = "false";

const {
  parseMemoryCandidates,
  saveExtractedMemories
} = await import("../src/memory-extraction.js");
const { listMemories } = await import("../src/agent-store.js");

test("parses fenced JSON arrays from model output", () => {
  const items = parseMemoryCandidates(
    '好的，结果如下：\n```json\n[{"type":"goal","content":"目标全马破三","importance":0.9}]\n```'
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "goal");
  assert.equal(items[0].content, "目标全马破三");
  assert.equal(items[0].importance, 0.9);
});

test("returns an empty list for invalid or non-array output", () => {
  assert.deepEqual(parseMemoryCandidates("没有可提取的内容"), []);
  assert.deepEqual(parseMemoryCandidates('{"type":"goal"}'), []);
  assert.deepEqual(parseMemoryCandidates("[broken"), []);
});

test("caps candidates at three entries", () => {
  const items = parseMemoryCandidates(
    JSON.stringify(
      Array.from({ length: 5 }, (_, index) => ({
        type: "preference",
        content: `偏好条目${index}`,
        importance: 0.5
      }))
    )
  );
  assert.equal(items.length, 3);
});

test("falls back to preference for unknown types and drops bad content", () => {
  const items = parseMemoryCandidates(
    JSON.stringify([
      { type: "unknown", content: "习惯晚上训练", importance: 0.7 },
      { type: "goal", content: "短", importance: 0.7 },
      { type: "goal", content: "x".repeat(200), importance: 0.7 },
      null,
      "text"
    ])
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "preference");
});

test("clamps importance into the 0-1 range", () => {
  const items = parseMemoryCandidates(
    JSON.stringify([{ type: "goal", content: "目标半马破二", importance: 3 }])
  );
  assert.equal(items[0].importance, 1);
});

test("saves extracted memories with the auto source", () => {
  const result = saveExtractedMemories([
    { type: "preference", content: "周一没有时间训练", importance: 0.8 }
  ]);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].source, "auto");
  assert.ok(listMemories(10).some((item) => item.content === "周一没有时间训练"));
});

test("skips exact and contained duplicates", () => {
  saveExtractedMemories([
    { type: "preference", content: "周二晚上固定训练", importance: 0.8 }
  ]);
  const result = saveExtractedMemories([
    { type: "preference", content: "周二晚上固定训练。", importance: 0.8 },
    { type: "preference", content: "周二晚上", importance: 0.8 }
  ]);
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 2);
});
