import { randomUUID } from "node:crypto";
import { db, USER_ID } from "./db.js";

export const DEFAULT_SESSION_ID = "local-default";
export const MEMORY_TYPES = new Set([
  "goal",
  "preference",
  "injury",
  "decision",
  "profile"
]);
const WEEKDAY_PATTERN = /(?:周|星期|礼拜)([一二三四五六日天])/g;
const UNAVAILABLE_PATTERN =
  /跑不了|不能跑|无法跑|不跑|没空|没时间|没有时间|不方便|去不了|不训练|休息/;
const AVAILABLE_PATTERN = /可以跑|能跑|有空|有时间|方便跑|恢复训练/;
const SESSION_TYPE_PATTERN =
  /冲刺|短间歇|间歇|节奏跑|阈值|法特莱克|坡跑|轻松跑|速度跑|跑长|长一些|跑短|短一些/;
const SURFACE_PATTERNS = [
  { value: "outdoor", pattern: /户外|室外|公园|山路|田径场|操场/ },
  { value: "trail", pattern: /越野|山路|trail/i },
  { value: "indoor", pattern: /室内|跑步机/ }
];
const WEEKDAY_NUMBERS = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0
};

const now = () => new Date().toISOString();

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    summary_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    importance REAL NOT NULL DEFAULT 0.5,
    source TEXT,
    last_used_at TEXT,
    facets_json TEXT,
    superseded_at TEXT,
    superseded_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    memory_id UNINDEXED,
    content,
    tokenize = 'unicode61'
  );

  CREATE TABLE IF NOT EXISTS runner_profile (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    goal_race TEXT,
    goal_date TEXT,
    target_time TEXT,
    pb5k TEXT,
    pb10k TEXT,
    pb_half TEXT,
    pb_full TEXT,
    available_days TEXT,
    preferred_long_run_day TEXT,
    injury_notes TEXT,
    notes TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT,
    question TEXT NOT NULL,
    model_label TEXT,
    model_json TEXT,
    prompt_version TEXT,
    context_json TEXT,
    usage_json TEXT,
    answer TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_no INTEGER NOT NULL,
    type TEXT NOT NULL,
    tool_name TEXT,
    input_json TEXT,
    output_json TEXT,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS training_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    workout_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    rpe INTEGER,
    notes TEXT,
    source TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS confirmation_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    run_id TEXT,
    tool_name TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT,
    payload_json TEXT,
    progress REAL NOT NULL DEFAULT 0,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompt_versions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_user
  ON memory_items(user_id, importance DESC, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_runs_session
  ON agent_runs(user_id, session_id, started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_runs_status
  ON agent_runs(user_id, status);

  CREATE INDEX IF NOT EXISTS idx_steps_run
  ON agent_steps(run_id, step_no);

  CREATE INDEX IF NOT EXISTS idx_training_user_date
  ON training_sessions(user_id, date);

  CREATE INDEX IF NOT EXISTS idx_jobs_user_status
  ON jobs(user_id, status, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_confirm_user_expiry
  ON confirmation_tokens(user_id, expires_at);
`);

const memoryColumns = db.prepare("PRAGMA table_info(memory_items)").all();
if (!memoryColumns.some((column) => column.name === "superseded_at")) {
  db.exec("ALTER TABLE memory_items ADD COLUMN superseded_at TEXT");
}
if (!memoryColumns.some((column) => column.name === "superseded_by")) {
  db.exec("ALTER TABLE memory_items ADD COLUMN superseded_by TEXT");
}
if (!memoryColumns.some((column) => column.name === "facets_json")) {
  db.exec("ALTER TABLE memory_items ADD COLUMN facets_json TEXT");
}
const memoriesToIndex = db
  .prepare("SELECT id, type, content FROM memory_items")
  .all();
const saveFacets = db.prepare(
  "UPDATE memory_items SET facets_json = ? WHERE id = ?"
);
for (const memory of memoriesToIndex) {
  saveFacets.run(
    JSON.stringify(memoryFacets(memory.type, memory.content)),
    memory.id
  );
}
repairInvalidSupersessions();

const messageColumns = db.prepare("PRAGMA table_info(messages)").all();
const hasColumn = (name) => messageColumns.some((column) => column.name === name);
if (!hasColumn("session_id")) {
  db.exec("ALTER TABLE messages ADD COLUMN session_id TEXT");
}
if (!hasColumn("token_count")) {
  db.exec("ALTER TABLE messages ADD COLUMN token_count INTEGER");
}
if (!hasColumn("run_id")) {
  db.exec("ALTER TABLE messages ADD COLUMN run_id TEXT");
}
const jobColumns = db.prepare("PRAGMA table_info(jobs)").all();
if (!jobColumns.some((column) => column.name === "payload_json")) {
  db.exec("ALTER TABLE jobs ADD COLUMN payload_json TEXT");
}

db.prepare(
  `INSERT OR IGNORE INTO sessions (
    id, user_id, title, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?)`
).run(DEFAULT_SESSION_ID, USER_ID, "训练对话", now(), now());
db.prepare(
  "UPDATE messages SET session_id = ? WHERE session_id IS NULL"
).run(DEFAULT_SESSION_ID);
db.exec(
  "UPDATE messages SET token_count = MAX(1, CAST((LENGTH(content) + 3) / 4 AS INTEGER)) WHERE token_count IS NULL"
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(user_id, session_id, created_at DESC)"
);

function safeJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapMessage(row) {
  return {
    ...row,
    tokenCount: row.token_count,
    runId: row.run_id,
    token_count: undefined,
    run_id: undefined
  };
}

export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

export function listSessions() {
  return db
    .prepare(
      `SELECT
        s.id, s.title, s.summary, s.summary_until AS summaryUntil,
        s.created_at AS createdAt, s.updated_at AS updatedAt,
        COUNT(m.id) AS messageCount,
        COALESCE(SUM(m.token_count), 0) AS tokenCount
       FROM sessions s
       LEFT JOIN messages m
         ON m.session_id = s.id AND m.user_id = s.user_id
       WHERE s.user_id = ?
       GROUP BY s.id
       ORDER BY s.updated_at DESC`
    )
    .all(USER_ID);
}

export function getSession(sessionId) {
  return db
    .prepare(
      `SELECT
        id, title, summary, summary_until AS summaryUntil,
        created_at AS createdAt, updated_at AS updatedAt
       FROM sessions
       WHERE id = ? AND user_id = ?`
    )
    .get(sessionId, USER_ID);
}

export function createSession(title = "新训练对话") {
  const id = randomUUID();
  const timestamp = now();
  db.prepare(
    `INSERT INTO sessions (
      id, user_id, title, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(id, USER_ID, String(title).trim() || "新训练对话", timestamp, timestamp);
  return getSession(id);
}

export function updateSession(sessionId, { title, summary, summaryUntil } = {}) {
  const session = getSession(sessionId);
  if (!session) return null;
  db.prepare(
    `UPDATE sessions
     SET title = COALESCE(?, title),
         summary = COALESCE(?, summary),
         summary_until = COALESCE(?, summary_until),
         updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    title === undefined ? null : String(title).trim() || session.title,
    summary === undefined ? null : summary,
    summaryUntil === undefined ? null : summaryUntil,
    now(),
    sessionId,
    USER_ID
  );
  return getSession(sessionId);
}

export function deleteSession(sessionId) {
  const sessions = listSessions();
  if (sessions.length <= 1) {
    throw new Error("至少需要保留一个会话");
  }
  if (!getSession(sessionId)) return false;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM messages WHERE session_id = ? AND user_id = ?").run(
      sessionId,
      USER_ID
    );
    db.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").run(
      sessionId,
      USER_ID
    );
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listSessionMessages(sessionId, limit = 100) {
  return db
    .prepare(
      `SELECT
        role, content, model_label AS modelLabel, created_at AS createdAt,
        token_count, run_id
       FROM (
         SELECT role, content, model_label, created_at, token_count, run_id
         FROM messages
         WHERE user_id = ? AND session_id = ?
         ORDER BY rowid DESC
         LIMIT ?
       )
       ORDER BY created_at ASC`
    )
    .all(USER_ID, sessionId, limit)
    .map(mapMessage);
}

export function clearSessionMessages(sessionId) {
  if (!getSession(sessionId)) return 0;
  return db
    .prepare("DELETE FROM messages WHERE user_id = ? AND session_id = ?")
    .run(USER_ID, sessionId).changes;
}

export function listSessionMessagesBefore(sessionId, before, limit = 40) {
  return db
    .prepare(
      `SELECT
        role, content, model_label AS modelLabel, created_at AS createdAt,
        token_count, run_id
       FROM (
         SELECT role, content, model_label, created_at, token_count, run_id
         FROM messages
         WHERE user_id = ? AND session_id = ?
           AND (? IS NULL OR created_at < ?)
         ORDER BY rowid DESC
         LIMIT ?
       )
       ORDER BY created_at ASC`
    )
    .all(USER_ID, sessionId, before || null, before || null, limit)
    .map(mapMessage);
}

export function saveSessionMessage({
  sessionId,
  role,
  content,
  modelLabel = null,
  tokenCount = estimateTokens(content),
  runId = null
}) {
  const id = randomUUID();
  const timestamp = now();
  db.prepare(
    `INSERT INTO messages (
      id, user_id, role, content, model_label, created_at,
      session_id, token_count, run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    USER_ID,
    role,
    content,
    modelLabel,
    timestamp,
    sessionId,
    tokenCount,
    runId
  );
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ? AND user_id = ?").run(
    timestamp,
    sessionId,
    USER_ID
  );
  return { id, createdAt: timestamp };
}

export function sessionMemoryStats(sessionId) {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS messageCount,
        COALESCE(SUM(token_count), 0) AS tokenCount
       FROM messages
       WHERE user_id = ? AND session_id = ?`
    )
    .get(USER_ID, sessionId);
  const session = getSession(sessionId);
  return {
    sessionId,
    messageCount: row?.messageCount || 0,
    tokenCount: row?.tokenCount || 0,
    summary: session?.summary || null,
    summaryUntil: session?.summaryUntil || null
  };
}

export function getRunnerProfile() {
  const profile = db
    .prepare("SELECT * FROM runner_profile WHERE user_id = ?")
    .get(USER_ID);
  if (!profile) {
    return {
      displayName: "",
      goalRace: "",
      goalDate: "",
      targetTime: "",
      pb5k: "",
      pb10k: "",
      pbHalf: "",
      pbFull: "",
      availableDays: "",
      preferredLongRunDay: "",
      injuryNotes: "",
      notes: "",
      updatedAt: null
    };
  }
  return {
    displayName: profile.display_name || "",
    goalRace: profile.goal_race || "",
    goalDate: profile.goal_date || "",
    targetTime: profile.target_time || "",
    pb5k: profile.pb5k || "",
    pb10k: profile.pb10k || "",
    pbHalf: profile.pb_half || "",
    pbFull: profile.pb_full || "",
    availableDays: profile.available_days || "",
    preferredLongRunDay: profile.preferred_long_run_day || "",
    injuryNotes: profile.injury_notes || "",
    notes: profile.notes || "",
    updatedAt: profile.updated_at
  };
}

export function saveRunnerProfile(input = {}) {
  const timestamp = now();
  db.prepare(
    `INSERT INTO runner_profile (
      user_id, display_name, goal_race, goal_date, target_time,
      pb5k, pb10k, pb_half, pb_full, available_days,
      preferred_long_run_day, injury_notes, notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      goal_race = excluded.goal_race,
      goal_date = excluded.goal_date,
      target_time = excluded.target_time,
      pb5k = excluded.pb5k,
      pb10k = excluded.pb10k,
      pb_half = excluded.pb_half,
      pb_full = excluded.pb_full,
      available_days = excluded.available_days,
      preferred_long_run_day = excluded.preferred_long_run_day,
      injury_notes = excluded.injury_notes,
      notes = excluded.notes,
      updated_at = excluded.updated_at`
  ).run(
    USER_ID,
    String(input.displayName || "").trim(),
    String(input.goalRace || "").trim(),
    String(input.goalDate || "").trim(),
    String(input.targetTime || "").trim(),
    String(input.pb5k || "").trim(),
    String(input.pb10k || "").trim(),
    String(input.pbHalf || "").trim(),
    String(input.pbFull || "").trim(),
    String(input.availableDays || "").trim(),
    String(input.preferredLongRunDay || "").trim(),
    String(input.injuryNotes || "").trim(),
    String(input.notes || "").trim(),
    timestamp
  );
  return getRunnerProfile();
}

function indexMemory(item) {
  db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(item.id);
  db.prepare("INSERT INTO memory_fts (memory_id, content) VALUES (?, ?)").run(
    item.id,
    item.content
  );
}

function mapMemory(row) {
  let facets;
  try {
    facets = row.facets_json ? JSON.parse(row.facets_json) : null;
  } catch {
    facets = null;
  }
  if (!Array.isArray(facets)) {
    facets = memoryFacets(row.type, row.content);
  }
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    importance: row.importance,
    source: row.source,
    facets,
    supersededAt: row.superseded_at,
    supersededBy: row.superseded_by,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeImportance(value, fallback = 0.5) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeMemoryType(value, fallback = "preference") {
  return MEMORY_TYPES.has(value) ? value : fallback;
}

function addFacet(facets, seen, scope, attribute, value) {
  const key = `${scope}/${attribute}`;
  if (seen.has(`${key}=${value}`)) return;
  seen.add(`${key}=${value}`);
  facets.push({ key, scope, attribute, value });
}

function memoryFacets(type, content) {
  const text = String(content || "");
  const facets = [];
  const seen = new Set();
  const clauses = text
    .split(/[，。；！？,;!?\n]/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const weekdays = [...clause.matchAll(WEEKDAY_PATTERN)]
      .map((match) => WEEKDAY_NUMBERS[match[1]])
      .filter((value) => value !== undefined);
    const scopes = weekdays.length
      ? weekdays.map((weekday) => `weekday:${weekday}`)
      : ["global"];
    if (weekdays.length && UNAVAILABLE_PATTERN.test(clause)) {
      for (const scope of scopes) {
        addFacet(facets, seen, scope, "availability", "unavailable");
      }
    } else if (weekdays.length && AVAILABLE_PATTERN.test(clause)) {
      for (const scope of scopes) {
        addFacet(facets, seen, scope, "availability", "available");
      }
    }
    for (const surface of SURFACE_PATTERNS) {
      if (!surface.pattern.test(clause)) continue;
      for (const scope of scopes) {
        addFacet(facets, seen, scope, "surface", surface.value);
      }
    }
    const sessionType = clause.match(SESSION_TYPE_PATTERN)?.[0];
    if (sessionType) {
      for (const scope of scopes) {
        addFacet(facets, seen, scope, "session-type", sessionType);
      }
    }
    if (/(?:长距离|LSD)/i.test(clause)) {
      for (const scope of scopes) {
        addFacet(facets, seen, scope, "long-distance-day", "true");
      }
    }
  }
  if (
    type === "goal" ||
    /(?:目标|比赛).*(?:马拉松|半马|10\s*k|10\s*公里|5\s*k|5\s*公里)/i.test(
      text
    )
  ) {
    addFacet(facets, seen, "global", "goal-race", "true");
  }
  return facets;
}

function supersedeConflictingMemories(id, type, content) {
  const keys = new Set(memoryFacets(type, content).map((facet) => facet.key));
  if (!keys.size) return;
  const candidates = db
    .prepare(
      `SELECT *
       FROM memory_items
       WHERE user_id = ? AND id <> ? AND superseded_at IS NULL`
    )
    .all(USER_ID, id);
  const timestamp = now();
  const markSuperseded = db.prepare(
    `UPDATE memory_items
     SET superseded_at = ?, superseded_by = ?, updated_at = ?
     WHERE id = ? AND user_id = ? AND superseded_at IS NULL`
  );
  const removeIndex = db.prepare("DELETE FROM memory_fts WHERE memory_id = ?");
  for (const candidate of candidates) {
    let candidateFacets;
    try {
      candidateFacets = candidate.facets_json
        ? JSON.parse(candidate.facets_json)
        : memoryFacets(candidate.type, candidate.content);
    } catch {
      candidateFacets = memoryFacets(candidate.type, candidate.content);
    }
    const candidateKeys = new Set(
      (Array.isArray(candidateFacets) ? candidateFacets : []).map(
        (facet) => facet.key
      )
    );
    if (![...keys].some((key) => candidateKeys.has(key))) continue;
    markSuperseded.run(timestamp, id, timestamp, candidate.id, USER_ID);
    removeIndex.run(candidate.id);
  }
}

export function repairInvalidSupersessions() {
  const rows = db
    .prepare(
      `SELECT m.*, s.facets_json AS superseder_facets_json
       FROM memory_items m
       JOIN memory_items s ON s.id = m.superseded_by
       WHERE m.user_id = ? AND m.superseded_at IS NOT NULL
         AND s.user_id = ?`
    )
    .all(USER_ID, USER_ID);
  let restored = 0;
  for (const row of rows) {
    let ownFacets;
    let supersederFacets;
    try {
      ownFacets = JSON.parse(row.facets_json || "[]");
      supersederFacets = JSON.parse(row.superseder_facets_json || "[]");
    } catch {
      continue;
    }
    const ownKeys = new Set(
      (Array.isArray(ownFacets) ? ownFacets : []).map((facet) => facet.key)
    );
    const supersederKeys = new Set(
      (Array.isArray(supersederFacets) ? supersederFacets : []).map(
        (facet) => facet.key
      )
    );
    if ([...ownKeys].some((key) => supersederKeys.has(key))) continue;
    db.prepare(
      `UPDATE memory_items
       SET superseded_at = NULL, superseded_by = NULL, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(now(), row.id, USER_ID);
    indexMemory(row);
    restored += 1;
  }
  return restored;
}

export function listMemories(limit = 100) {
  return db
    .prepare(
      `SELECT *
       FROM memory_items
       WHERE user_id = ? AND superseded_at IS NULL
       ORDER BY importance DESC, updated_at DESC
       LIMIT ?`
    )
    .all(USER_ID, limit)
    .map(mapMemory);
}

export function createMemory({ type = "preference", content, importance = 0.5, source = "manual" }) {
  const id = randomUUID();
  const timestamp = now();
  const safeType = normalizeMemoryType(type);
  const safeContent = String(content || "").trim();
  db.prepare(
    `INSERT INTO memory_items (
      id, user_id, type, content, importance, source,
      facets_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    USER_ID,
    safeType,
    safeContent,
    normalizeImportance(importance),
    source,
    JSON.stringify(memoryFacets(safeType, safeContent)),
    timestamp,
    timestamp
  );
  const item = db
    .prepare("SELECT * FROM memory_items WHERE id = ?")
    .get(id);
  indexMemory(item);
  supersedeConflictingMemories(id, safeType, item.content);
  return mapMemory(item);
}

export function updateMemory(id, { type, content, importance } = {}) {
  const existing = db
    .prepare("SELECT * FROM memory_items WHERE id = ? AND user_id = ?")
    .get(id, USER_ID);
  if (!existing) return null;
  const safeType = normalizeMemoryType(type || existing.type, existing.type);
  const safeContent =
    content === undefined ? existing.content : String(content).trim();
  db.prepare(
    `UPDATE memory_items
     SET type = ?, content = ?, importance = ?, facets_json = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    safeType,
    safeContent,
    importance === undefined
      ? existing.importance
      : normalizeImportance(importance, existing.importance),
    JSON.stringify(memoryFacets(safeType, safeContent)),
    now(),
    id,
    USER_ID
  );
  const item = db
    .prepare("SELECT * FROM memory_items WHERE id = ?")
    .get(id);
  indexMemory(item);
  supersedeConflictingMemories(id, item.type, item.content);
  return mapMemory(item);
}

export function deleteMemory(id) {
  db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(id);
  return (
    db.prepare("DELETE FROM memory_items WHERE id = ? AND user_id = ?").run(
      id,
      USER_ID
    ).changes > 0
  );
}

export function searchMemories(query, limit = 5) {
  const text = String(query || "").trim();
  if (!text) {
    return db
      .prepare(
        `SELECT *
         FROM memory_items
         WHERE user_id = ? AND superseded_at IS NULL
         ORDER BY importance DESC, updated_at DESC
         LIMIT ?`
      )
      .all(USER_ID, limit)
      .map(mapMemory);
  }
  const baseTokens = text
    .split(/\s+/)
    .map((item) => item.replaceAll('"', ""))
    .filter(Boolean);
  const cjkText = text.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
  const bigrams = [];
  for (let index = 0; index < cjkText.length - 1; index += 1) {
    const part = cjkText.slice(index, index + 2);
    if (/^[\u4e00-\u9fff]{2}$/.test(part)) bigrams.push(part);
  }
  const tokens = [...new Set([...baseTokens, ...bigrams])].slice(0, 20);
  let rows = [];
  if (tokens.length) {
    try {
      const match = tokens.map((token) => `"${token}"*`).join(" OR ");
      rows = db
        .prepare(
          `SELECT m.*, bm25(memory_fts) AS score
           FROM memory_fts
           JOIN memory_items m ON m.id = memory_fts.memory_id
           WHERE memory_fts MATCH ? AND m.user_id = ?
             AND m.superseded_at IS NULL
           ORDER BY m.importance DESC, score ASC
           LIMIT ?`
        )
        .all(match, USER_ID, limit);
    } catch {
      rows = [];
    }
  }
  if (!rows.length) {
    const clauses = tokens.length
      ? tokens.map(() => "content LIKE ?").join(" OR ")
      : "content LIKE ?";
    const params = tokens.length
      ? tokens.map((token) => `%${token}%`)
      : [`%${text}%`];
    rows = db
      .prepare(
        `SELECT *
         FROM memory_items
         WHERE user_id = ? AND superseded_at IS NULL AND (${clauses})
         ORDER BY importance DESC, updated_at DESC
         LIMIT ?`
      )
      .all(USER_ID, ...params, limit);
  }
  if (rows.length) {
    const stamp = now();
    const markUsed = db.prepare(
      "UPDATE memory_items SET last_used_at = ? WHERE id = ? AND user_id = ?"
    );
    for (const row of rows) markUsed.run(stamp, row.id, USER_ID);
  }
  return rows.map(mapMemory);
}

export function createAgentRun({
  id,
  sessionId,
  question,
  modelLabel,
  model,
  promptVersion,
  context
}) {
  const timestamp = now();
  db.prepare(
    `INSERT INTO agent_runs (
      id, session_id, user_id, status, stage, question,
      model_label, model_json, prompt_version, context_json, started_at
    ) VALUES (?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    sessionId,
    USER_ID,
    question,
    modelLabel || null,
    JSON.stringify(model || {}),
    promptVersion || null,
    JSON.stringify(context || {}),
    timestamp
  );
  return getAgentRun(id);
}

export function getAgentRun(runId) {
  const row = db
    .prepare("SELECT * FROM agent_runs WHERE id = ? AND user_id = ?")
    .get(runId, USER_ID);
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    stage: row.stage,
    question: row.question,
    modelLabel: row.model_label,
    model: safeJson(row.model_json, {}),
    promptVersion: row.prompt_version,
    context: safeJson(row.context_json, {}),
    usage: safeJson(row.usage_json, null),
    answer: row.answer,
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at
  };
}

export function failInterruptedRuns(message = "服务重启后运行已中断") {
  return db
    .prepare(
      `UPDATE agent_runs
       SET status = 'failed', stage = 'failed', error = ?, ended_at = ?
       WHERE user_id = ?
         AND status NOT IN ('completed', 'failed', 'cancelled')`
    )
    .run(message, now(), USER_ID).changes;
}

export function pruneAgentAudit({ days = 90 } = {}) {
  const retentionDays = Number(days);
  const effectiveDays =
    Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 90;
  const cutoff = new Date(
    Date.now() - effectiveDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const steps = db
    .prepare(
      `DELETE FROM agent_steps
       WHERE run_id IN (
         SELECT id FROM agent_runs WHERE user_id = ? AND started_at < ?
       )`
    )
    .run(USER_ID, cutoff).changes;
  const runs = db
    .prepare(
      `DELETE FROM agent_runs
       WHERE user_id = ? AND started_at < ?`
    )
    .run(USER_ID, cutoff).changes;
  return { days: effectiveDays, cutoff, runs, steps };
}

export function updateAgentRun(runId, changes = {}) {
  const current = getAgentRun(runId);
  if (!current) return null;
  db.prepare(
    `UPDATE agent_runs
     SET status = ?, stage = ?, context_json = ?, usage_json = ?,
         answer = ?, error = ?, ended_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    changes.status ?? current.status,
    changes.stage ?? current.stage,
    changes.context === undefined ? JSON.stringify(current.context || {}) : JSON.stringify(changes.context),
    changes.usage === undefined ? JSON.stringify(current.usage || null) : JSON.stringify(changes.usage),
    changes.answer === undefined ? current.answer : changes.answer,
    changes.error === undefined ? current.error : changes.error,
    changes.endedAt === undefined ? current.endedAt : changes.endedAt,
    runId,
    USER_ID
  );
  return getAgentRun(runId);
}

export function addAgentStep({
  runId,
  stepNo,
  type,
  toolName = null,
  input = null,
  output = null,
  status = "completed",
  durationMs = null
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO agent_steps (
      id, run_id, step_no, type, tool_name, input_json,
      output_json, status, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    runId,
    stepNo,
    type,
    toolName,
    JSON.stringify(input),
    JSON.stringify(output),
    status,
    durationMs,
    now()
  );
  return {
    id,
    runId,
    stepNo,
    type,
    toolName,
    input,
    output,
    status,
    durationMs
  };
}

export function listAgentSteps(runId) {
  return db
    .prepare(
      `SELECT *
       FROM agent_steps
       WHERE run_id = ?
       ORDER BY step_no ASC, created_at ASC`
    )
    .all(runId)
    .map((row) => ({
      id: row.id,
      runId: row.run_id,
      stepNo: row.step_no,
      type: row.type,
      toolName: row.tool_name,
      input: safeJson(row.input_json, null),
      output: safeJson(row.output_json, null),
      status: row.status,
      durationMs: row.duration_ms,
      createdAt: row.created_at
    }));
}

export function savePromptVersion(name, content) {
  const hash = createSimpleHash(content);
  const existing = db
    .prepare(
      "SELECT id FROM prompt_versions WHERE name = ? AND content_hash = ?"
    )
    .get(name, hash);
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO prompt_versions (
      id, name, content_hash, content, created_at
    ) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, hash, content, now());
  return id;
}

function createSimpleHash(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createConfirmation({
  runId,
  toolName,
  payload,
  ttlSeconds = 900
}) {
  const token = randomUUID().replaceAll("-", "");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
  db.prepare(
    `INSERT INTO confirmation_tokens (
      token, user_id, run_id, tool_name, payload_json,
      expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    token,
    USER_ID,
    runId || null,
    toolName,
    JSON.stringify(payload),
    expiresAt.toISOString(),
    createdAt.toISOString()
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

export function consumeConfirmation(token, toolName) {
  const row = db
    .prepare(
      `SELECT *
       FROM confirmation_tokens
       WHERE token = ? AND user_id = ? AND tool_name = ?`
    )
    .get(token, USER_ID, toolName);
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  db.prepare("UPDATE confirmation_tokens SET used_at = ? WHERE token = ?").run(
    now(),
    token
  );
  return {
    runId: row.run_id,
    payload: safeJson(row.payload_json, {})
  };
}

export function saveTrainingSessions({
  sessions,
  source = "agent",
  runId = null
}) {
  const timestamp = now();
  db.exec("BEGIN");
  try {
    const preserved = db.prepare(
      `SELECT id FROM training_sessions
       WHERE user_id = ? AND date = ?
         AND source IN ('agent', 'coros-planned')
         AND status IN ('completed', 'skipped')
       LIMIT 1`
    );
    const clearPlanned = db.prepare(
      `DELETE FROM training_sessions
       WHERE user_id = ? AND date = ?
         AND source IN ('agent', 'coros-planned')
         AND status = 'planned'`
    );
    for (const item of sessions) {
      if (preserved.get(USER_ID, item.date)) continue;
      clearPlanned.run(USER_ID, item.date);
      const id = item.id || randomUUID();
      db.prepare(
        `INSERT INTO training_sessions (
          id, user_id, date, workout_json, status, source,
          run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          date = excluded.date,
          workout_json = excluded.workout_json,
          source = excluded.source,
          run_id = excluded.run_id,
          updated_at = excluded.updated_at`
      ).run(
        id,
        USER_ID,
        item.date,
        JSON.stringify(item.workout || item),
        item.status || "planned",
        source,
        runId,
        timestamp,
        timestamp
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return listTrainingSessions({ start: sessions[0]?.date, end: sessions.at(-1)?.date });
}

export function listTrainingSessions({ start, end } = {}) {
  const rows = start && end
    ? db
        .prepare(
          `SELECT *
           FROM training_sessions
           WHERE user_id = ? AND date >= ? AND date <= ?
           ORDER BY date ASC`
        )
        .all(USER_ID, start, end)
    : db
        .prepare(
          `SELECT *
           FROM training_sessions
           WHERE user_id = ?
           ORDER BY date ASC`
        )
        .all(USER_ID);
  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    workout: safeJson(row.workout_json, {}),
    status: row.status,
    rpe: row.rpe,
    notes: row.notes,
    source: row.source,
    runId: row.run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  }));
}

export function checkInTrainingSession(id, { status = "completed", rpe = null, notes = "" } = {}) {
  const safeStatus = ["completed", "skipped", "planned"].includes(status)
    ? status
    : "completed";
  const timestamp = now();
  const changes = db
    .prepare(
      `UPDATE training_sessions
       SET status = ?, rpe = ?, notes = ?, updated_at = ?,
           completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END
       WHERE id = ? AND user_id = ?`
    )
    .run(
      safeStatus,
      rpe === null || rpe === "" ? null : Math.max(1, Math.min(10, Number(rpe))),
      String(notes || "").trim(),
      timestamp,
      safeStatus,
      timestamp,
      id,
      USER_ID
    ).changes;
  return changes > 0;
}

export function createJob({
  id = randomUUID(),
  type,
  idempotencyKey = null,
  payload = {}
}) {
  if (idempotencyKey) {
    const existing = db
      .prepare("SELECT * FROM jobs WHERE user_id = ? AND idempotency_key = ?")
      .get(USER_ID, idempotencyKey);
    if (existing) return mapJob(existing);
  }
  const timestamp = now();
  db.prepare(
    `INSERT INTO jobs (
      id, user_id, type, status, idempotency_key, payload_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`
  ).run(
    id,
    USER_ID,
    type,
    idempotencyKey,
    JSON.stringify(payload),
    timestamp,
    timestamp
  );
  return getJob(id);
}

export function getJob(id) {
  const row = db
    .prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
    .get(id, USER_ID);
  return row ? mapJob(row) : null;
}

function mapJob(row) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    payload: safeJson(row.payload_json, {}),
    progress: row.progress,
    result: safeJson(row.result_json, null),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at
  };
}

export function updateJob(id, changes = {}) {
  const current = getJob(id);
  if (!current) return null;
  const timestamp = now();
  db.prepare(
    `UPDATE jobs
     SET status = ?, progress = ?, result_json = ?, error = ?,
         started_at = ?, ended_at = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    changes.status ?? current.status,
    changes.progress ?? current.progress,
    changes.result === undefined ? JSON.stringify(current.result) : JSON.stringify(changes.result),
    changes.error === undefined ? current.error : changes.error,
    changes.startedAt === undefined ? current.startedAt : changes.startedAt,
    changes.endedAt === undefined ? current.endedAt : changes.endedAt,
    timestamp,
    id,
    USER_ID
  );
  return getJob(id);
}

export function listJobs(limit = 30) {
  return db
    .prepare(
      `SELECT *
       FROM jobs
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(USER_ID, limit)
    .map(mapJob);
}
