import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { buildDemoActivities } from "./seed.js";

export const DEFAULT_USER_ID = "local-runner";
const userContext = new AsyncLocalStorage();

export function currentUserId() {
  return userContext.getStore()?.userId || DEFAULT_USER_ID;
}

export function runAsUser(userId, callback) {
  return userContext.run({ userId: String(userId) }, callback);
}

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, "running-agent.db");
export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    import_id TEXT,
    started_at TEXT NOT NULL,
    duration_sec INTEGER NOT NULL,
    distance_m REAL NOT NULL,
    avg_pace_sec_per_km REAL,
    avg_heart_rate REAL,
    max_heart_rate REAL,
    cadence REAL,
    elevation_gain_m REAL,
    training_load REAL,
    route_json TEXT,
    raw_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, provider, external_id)
  );

  CREATE INDEX IF NOT EXISTS idx_activities_started_at
  ON activities(user_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    format TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    status TEXT NOT NULL,
    imported_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model_label TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coros_connection (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    region TEXT NOT NULL,
    issuer TEXT NOT NULL,
    mcp_url TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    encrypted_access_token TEXT,
    encrypted_refresh_token TEXT,
    token_type TEXT,
    scope TEXT,
    expires_at TEXT,
    last_sync_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

`);

const insertActivity = db.prepare(`
  INSERT OR IGNORE INTO activities (
    id, user_id, provider, external_id, import_id, started_at,
    duration_sec, distance_m, avg_pace_sec_per_km, avg_heart_rate,
    max_heart_rate, cadence, elevation_gain_m, training_load,
    route_json, raw_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateActivity = db.prepare(`
  UPDATE activities
  SET import_id = COALESCE(?, import_id),
      started_at = ?,
      duration_sec = ?,
      distance_m = ?,
      avg_pace_sec_per_km = ?,
      avg_heart_rate = ?,
      max_heart_rate = ?,
      cadence = ?,
      elevation_gain_m = ?,
      training_load = ?,
      route_json = ?,
      raw_json = ?
  WHERE user_id = ? AND provider = ? AND external_id = ?
`);

const findCrossSourceDuplicate = db.prepare(`
  SELECT id FROM activities
  WHERE user_id = ?
    AND provider <> ?
    AND provider <> 'demo'
    AND started_at >= ?
    AND started_at <= ?
    AND ABS(distance_m - ?) <= ?
    AND ABS(duration_sec - ?) <= ?
  LIMIT 1
`);

const CROSS_SOURCE_TIME_TOLERANCE_MS = 3 * 60 * 1000;

export function saveActivities(
  activities,
  importId = null,
  { updateExisting = false } = {}
) {
  let inserted = 0;
  let skipped = 0;
  let updated = 0;
  let crossSourceSkipped = 0;
  const createdAt = new Date().toISOString();

  db.exec("BEGIN");
  try {
    for (const activity of activities) {
      const provider = activity.provider || "upload";
      const startedAt = new Date(activity.startedAt).toISOString();
      const startedMs = Date.parse(startedAt);
      const durationSec = Math.round(activity.durationSec);
      const distanceM = Math.round(activity.distanceM);
      const duplicate = Number.isFinite(startedMs)
        ? findCrossSourceDuplicate.get(
            currentUserId(),
            provider,
            new Date(startedMs - CROSS_SOURCE_TIME_TOLERANCE_MS).toISOString(),
            new Date(startedMs + CROSS_SOURCE_TIME_TOLERANCE_MS).toISOString(),
            distanceM,
            Math.max(100, distanceM * 0.015),
            durationSec,
            Math.max(120, durationSec * 0.03)
          )
        : null;
      if (duplicate) {
        skipped += 1;
        crossSourceSkipped += 1;
        continue;
      }

      const result = insertActivity.run(
        randomUUID(),
        currentUserId(),
        provider,
        activity.externalId,
        importId,
        startedAt,
        durationSec,
        distanceM,
        activity.avgPaceSecPerKm ?? null,
        activity.avgHeartRate ?? null,
        activity.maxHeartRate ?? null,
        activity.cadence ?? null,
        activity.elevationGainM ?? null,
        activity.trainingLoad ?? null,
        activity.route ? JSON.stringify(activity.route) : null,
        JSON.stringify(activity.raw || {}),
        createdAt
      );
      if (result.changes > 0) {
        inserted += 1;
      } else {
        skipped += 1;
        if (updateExisting) {
          updateActivity.run(
            importId,
            startedAt,
            durationSec,
            distanceM,
            activity.avgPaceSecPerKm ?? null,
            activity.avgHeartRate ?? null,
            activity.maxHeartRate ?? null,
            activity.cadence ?? null,
            activity.elevationGainM ?? null,
            activity.trainingLoad ?? null,
            activity.route ? JSON.stringify(activity.route) : null,
            JSON.stringify(activity.raw || {}),
            currentUserId(),
            provider,
            activity.externalId
          );
          updated += 1;
        }
      }
    }
    db.exec("COMMIT");
    return { inserted, skipped, updated, crossSourceSkipped };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const activitySelect = `
  SELECT
    id, provider, external_id AS externalId, import_id AS importId,
    started_at AS startedAt, duration_sec AS durationSec,
    distance_m AS distanceM, avg_pace_sec_per_km AS avgPaceSecPerKm,
    avg_heart_rate AS avgHeartRate, max_heart_rate AS maxHeartRate,
    cadence, elevation_gain_m AS elevationGainM,
    training_load AS trainingLoad, route_json AS routeJson,
    raw_json AS rawJson, created_at AS createdAt
  FROM activities`;

function mapActivityRow(row) {
  const activity = {
    ...row,
    raw: row.rawJson ? JSON.parse(row.rawJson) : {},
    routeJson: undefined,
    rawJson: undefined
  };
  let routeParsed = false;
  let route = null;
  Object.defineProperty(activity, "route", {
    enumerable: true,
    get() {
      if (!routeParsed) {
        routeParsed = true;
        route = row.routeJson ? JSON.parse(row.routeJson) : null;
      }
      return route;
    }
  });
  return activity;
}

export function listActivities({ limit = 100 } = {}) {
  return db
    .prepare(
      `${activitySelect}
       WHERE user_id = ?
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .all(currentUserId(), limit)
    .map(mapActivityRow);
}

export function getActivity(id) {
  const row = db
    .prepare(`${activitySelect} WHERE user_id = ? AND id = ?`)
    .get(currentUserId(), String(id || ""));
  return row ? mapActivityRow(row) : null;
}

export function renameActivity(id, title) {
  const row = db
    .prepare("SELECT raw_json AS rawJson FROM activities WHERE user_id = ? AND id = ?")
    .get(currentUserId(), String(id || ""));
  if (!row) return null;
  let raw = {};
  try {
    raw = row.rawJson ? JSON.parse(row.rawJson) : {};
  } catch {
    raw = {};
  }
  raw.title = String(title || "").trim();
  db.prepare(
    "UPDATE activities SET raw_json = ? WHERE user_id = ? AND id = ?"
  ).run(JSON.stringify(raw), currentUserId(), String(id));
  return getActivity(id);
}

export function deleteActivity(id) {
  const row = db
    .prepare(
      "SELECT import_id AS importId FROM activities WHERE user_id = ? AND id = ?"
    )
    .get(currentUserId(), String(id || ""));
  if (!row) return null;
  db.prepare("DELETE FROM activities WHERE user_id = ? AND id = ?").run(
    currentUserId(),
    String(id)
  );
  if (row.importId) {
    const remaining = db
      .prepare(
        "SELECT COUNT(*) AS count FROM activities WHERE user_id = ? AND import_id = ?"
      )
      .get(currentUserId(), row.importId).count;
    db.prepare("UPDATE imports SET imported_count = ? WHERE user_id = ? AND id = ?").run(
      remaining,
      currentUserId(),
      row.importId
    );
  }
  return { deleted: true };
}

export function activityCount() {
  return db
    .prepare("SELECT COUNT(*) AS count FROM activities WHERE user_id = ?")
    .get(currentUserId()).count;
}

export function removeDemoActivities() {
  return db
    .prepare("DELETE FROM activities WHERE user_id = ? AND provider = 'demo'")
    .run(currentUserId()).changes;
}

export function createImport({ filename, format, fileSize, checksum }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO imports (
      id, user_id, filename, format, file_size, checksum, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)`
  ).run(id, currentUserId(), filename, format, fileSize, checksum, new Date().toISOString());
  return id;
}

export function finishImport(id, { status, imported, skipped, failed, error = null }) {
  db.prepare(
    `UPDATE imports
     SET status = ?, imported_count = ?, skipped_count = ?,
         error_count = ?, completed_at = ?, last_error = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    status,
    imported,
    skipped,
    failed,
    new Date().toISOString(),
    error,
    id,
    currentUserId()
  );
}

export function listImports(limit = 20) {
  return db
    .prepare(
      `SELECT
        id, filename, format, file_size AS fileSize, status,
        imported_count AS importedCount, skipped_count AS skippedCount,
        error_count AS errorCount, created_at AS createdAt,
        completed_at AS completedAt, last_error AS lastError
      FROM imports
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?`
    )
    .all(currentUserId(), limit);
}

export function deleteImport(id) {
  const imported = db
    .prepare("SELECT id FROM imports WHERE id = ? AND user_id = ?")
    .get(id, currentUserId());
  if (!imported) return null;

  const deletedActivities = db
    .prepare("DELETE FROM activities WHERE import_id = ? AND user_id = ?")
    .run(id, currentUserId()).changes;
  db.prepare("DELETE FROM imports WHERE id = ? AND user_id = ?").run(id, currentUserId());
  return { deletedActivities };
}

export function getCorosConnection() {
  return db
    .prepare(
      `SELECT
        id, region, issuer, mcp_url AS mcpUrl, client_id AS clientId,
        redirect_uri AS redirectUri, encrypted_access_token AS encryptedAccessToken,
        encrypted_refresh_token AS encryptedRefreshToken, token_type AS tokenType,
        scope, expires_at AS expiresAt, last_sync_at AS lastSyncAt,
        created_at AS createdAt, updated_at AS updatedAt
       FROM coros_connection
       WHERE user_id = ?
       LIMIT 1`
    )
    .get(currentUserId());
}

export function saveCorosClient({ region, issuer, mcpUrl, clientId, redirectUri }) {
  const existing = getCorosConnection();
  const now = new Date().toISOString();
  if (existing) {
    const endpointChanged =
      existing.issuer !== issuer || existing.redirectUri !== redirectUri;
    db.prepare(
      `UPDATE coros_connection
       SET region = ?, issuer = ?, mcp_url = ?, client_id = ?, redirect_uri = ?,
           encrypted_access_token = CASE WHEN ? THEN NULL ELSE encrypted_access_token END,
           encrypted_refresh_token = CASE WHEN ? THEN NULL ELSE encrypted_refresh_token END,
           token_type = CASE WHEN ? THEN NULL ELSE token_type END,
           scope = CASE WHEN ? THEN NULL ELSE scope END,
           expires_at = CASE WHEN ? THEN NULL ELSE expires_at END,
           updated_at = ?
       WHERE user_id = ?`
    ).run(
      region,
      issuer,
      mcpUrl,
      clientId,
      redirectUri,
      endpointChanged ? 1 : 0,
      endpointChanged ? 1 : 0,
      endpointChanged ? 1 : 0,
      endpointChanged ? 1 : 0,
      endpointChanged ? 1 : 0,
      now,
      currentUserId()
    );
    return;
  }
  db.prepare(
    `INSERT INTO coros_connection (
      id, user_id, region, issuer, mcp_url, client_id, redirect_uri,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    currentUserId(),
    region,
    issuer,
    mcpUrl,
    clientId,
    redirectUri,
    now,
    now
  );
}

export function saveCorosTokens({
  encryptedAccessToken,
  encryptedRefreshToken,
  tokenType,
  scope,
  expiresAt
}) {
  db.prepare(
    `UPDATE coros_connection
     SET encrypted_access_token = ?, encrypted_refresh_token = ?,
         token_type = ?, scope = ?, expires_at = ?, updated_at = ?
     WHERE user_id = ?`
  ).run(
    encryptedAccessToken,
    encryptedRefreshToken,
    tokenType,
    scope,
    expiresAt,
    new Date().toISOString(),
    currentUserId()
  );
}

export function updateCorosSyncTime() {
  db.prepare(
    "UPDATE coros_connection SET last_sync_at = ?, updated_at = ? WHERE user_id = ?"
  ).run(new Date().toISOString(), new Date().toISOString(), currentUserId());
}

export function clearCorosConnection() {
  return db.prepare("DELETE FROM coros_connection WHERE user_id = ?").run(currentUserId()).changes;
}

export function corosActivityCount() {
  return db
    .prepare("SELECT COUNT(*) AS count FROM activities WHERE user_id = ? AND provider = 'coros'")
    .get(currentUserId()).count;
}

export function resetDemoData() {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM activities WHERE user_id = ?").run(currentUserId());
    db.prepare("DELETE FROM imports WHERE user_id = ?").run(currentUserId());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return saveActivities(buildDemoActivities());
}

export function ensureUserInitialized() {
  if (activityCount() > 0 || process.env.SEED_DEMO === "false") return;
  saveActivities(buildDemoActivities());
}

ensureUserInitialized();
