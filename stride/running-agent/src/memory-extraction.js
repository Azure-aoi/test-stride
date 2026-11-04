import {
  MEMORY_TYPES,
  createMemory,
  listMemories
} from "./agent-store.js";
import { extractAgentMemories } from "./model-gateway.js";

const MAX_ITEMS = 3;

function normalizeText(text) {
  return String(text || "")
    .replace(/[\s，,。.!！?？、；;：:]/g, "")
    .trim();
}

export function parseMemoryCandidates(text) {
  const source = String(text || "").trim();
  const unfenced = source
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const items = [];
  const seen = new Set();
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const type = MEMORY_TYPES.has(raw.type) ? raw.type : "preference";
    const content = String(raw.content || "")
      .replace(/\s+/g, " ")
      .trim();
    if (content.length < 4 || content.length > 120) continue;
    if (seen.has(content)) continue;
    seen.add(content);
    const importance = Number(raw.importance);
    items.push({
      type,
      content,
      importance: Number.isFinite(importance)
        ? Math.max(0, Math.min(1, importance))
        : 0.6
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export function saveExtractedMemories(candidates) {
  const existing = listMemories(200)
    .map((item) => normalizeText(item.content))
    .filter((text) => text.length >= 4);
  const created = [];
  const skipped = [];

  for (const candidate of candidates) {
    const text = normalizeText(candidate.content);
    if (text.length < 4) continue;
    const duplicate = existing.some(
      (item) => item === text || item.includes(text) || text.includes(item)
    );
    if (duplicate) {
      skipped.push(candidate.content);
      continue;
    }
    created.push(createMemory({ ...candidate, source: "auto" }));
    existing.push(text);
  }

  return { created, skipped };
}

export async function extractAndSaveMemories({
  config,
  question,
  answer,
  signal = null
}) {
  const content = await extractAgentMemories({ config, question, answer, signal });
  return saveExtractedMemories(parseMemoryCandidates(content));
}
