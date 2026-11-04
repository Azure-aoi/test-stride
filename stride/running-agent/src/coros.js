import {
  createHash,
  randomBytes
} from "node:crypto";
import {
  clearCorosConnection,
  getCorosConnection,
  saveCorosClient,
  saveCorosTokens,
  updateCorosSyncTime
} from "./db.js";
import { decryptSecret, encryptSecret } from "./secret-store.js";

const SCOPES = "openid offline_access mcp.tools";
const CLIENT_NAME = "STRIDE OS Running Agent";
const AUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const pendingSessions = new Map();

const RUNNING_SPORT_TYPES = new Set([100, 101, 102, 103]);
const NON_RUNNING_SPORT_TYPES = new Set([
  104, 105, 106,
  200, 201, 202, 203, 204, 205, 299,
  300, 301,
  400, 401, 402,
  900, 1000, 1200, 10000,
  9800, 9801, 9802, 9803, 9804, 9805, 9806, 9807
]);
const RUNNING_NAME =
  /跑|\b(?:run|running|jog|jogging|trail\s*run|treadmill)\b/i;
const NON_RUNNING_NAME =
  /\b(?:walk|walking|hike|hiking|mountaineer|mountaineering|bike|biking|cycle|cycling|ride|riding|swim|swimming|strength|gym|cardio|row|rowing|ski|skiing|skate|elliptical|yoga|pilates|climb|climbing|tennis|basketball|football|soccer|golf|boxing)\b|骑行|单车|自行车|游泳|泳池|力量|健身|徒步|远足|登山|步行|健走|散步|划船|皮划艇|滑雪|滑冰|椭圆|爬楼|瑜伽|普拉提|攀岩|网球|篮球|足球|高尔夫|拳击/i;

export const COROS_REGIONS = {
  global: {
    label: "自动选择",
    issuer: "https://mcp.coros.com"
  },
  cn: {
    label: "中国大陆",
    issuer: "https://mcpcn.coros.com"
  },
  eu: {
    label: "欧洲",
    issuer: "https://mcpeu.coros.com"
  },
  us: {
    label: "美国及其他地区",
    issuer: "https://mcpus.coros.com"
  }
};

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function randomToken(bytes = 32) {
  return base64url(randomBytes(bytes));
}

function codeChallenge(verifier) {
  return base64url(createHash("sha256").update(verifier).digest());
}

function compactHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function errorWithCode(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function readResponse(response) {
  const raw = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const events = [];
    let current = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line) {
        if (current.length) events.push(current.join("\n"));
        current = [];
        continue;
      }
      if (line.startsWith("data:")) current.push(line.slice(5).trimStart());
    }
    if (current.length) events.push(current.join("\n"));
    const payload = events.at(-1);
    return payload ? JSON.parse(payload) : {};
  }
  return raw ? JSON.parse(raw) : {};
}

async function fetchJson(url, options = {}) {
  const { signal, ...rest } = options;
  const timeoutSignal = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    ...rest,
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  });
  const payload = await readResponse(response);
  if (!response.ok) {
    const message =
      payload?.error_description ||
      payload?.error?.message ||
      payload?.message ||
      `COROS request failed (${response.status})`;
    const error = errorWithCode(
      response.status === 401 ? "COROS_AUTH_EXPIRED" : "COROS_REQUEST_FAILED",
      message,
      response.status === 401 ? 401 : 502
    );
    error.details = payload;
    throw error;
  }
  return payload;
}

function normalizeIssuer(issuer) {
  return String(issuer || "").replace(/\/$/, "");
}

async function discoverIssuer(region = "global") {
  const requested = COROS_REGIONS[region] || COROS_REGIONS.global;
  const metadata = await fetchJson(`${requested.issuer}/.well-known/openid-configuration`);
  const issuer = normalizeIssuer(metadata.issuer || requested.issuer);
  if (!Object.values(COROS_REGIONS).some((item) => normalizeIssuer(item.issuer) === issuer)) {
    throw errorWithCode("COROS_INVALID_ISSUER", "COROS 返回了不受信任的授权服务地址", 502);
  }
  const resolvedRegion =
    Object.entries(COROS_REGIONS).find(
      ([id, item]) => id !== "global" && normalizeIssuer(item.issuer) === issuer
    )?.[0] || region;
  return {
    region: resolvedRegion,
    issuer,
    mcpUrl: `${issuer}/mcp`,
    authorizationEndpoint: `${issuer}/oauth2/authorize`,
    tokenEndpoint: `${issuer}/oauth2/token`,
    revocationEndpoint: `${issuer}/oauth2/revoke`,
    registrationEndpoint: `${issuer}/connect/register`
  };
}

function publicBaseUrl(request) {
  if (process.env.PUBLIC_BASE_URL) {
    return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, "");
  }
  return `${request.protocol}://${request.get("host")}`;
}

async function registerClient(issuer, redirectUri) {
  const payload = await fetchJson(`${issuer}/connect/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPES,
      token_endpoint_auth_method: "none"
    })
  });
  if (!payload.client_id) {
    throw errorWithCode("COROS_REGISTRATION_FAILED", "COROS 没有返回客户端标识", 502);
  }
  return payload.client_id;
}

function connectionTokenSnapshot(connection) {
  if (!connection?.encryptedAccessToken) return null;
  return {
    accessToken: decryptSecret(connection.encryptedAccessToken),
    refreshToken: decryptSecret(connection.encryptedRefreshToken),
    tokenType: connection.tokenType || "Bearer",
    scope: connection.scope || SCOPES,
    expiresAt: connection.expiresAt,
    clientId: connection.clientId,
    issuer: connection.issuer,
    mcpUrl: connection.mcpUrl,
    region: connection.region,
    redirectUri: connection.redirectUri
  };
}

export async function startCorosAuthorization(request, region = "global") {
  const discovery = await discoverIssuer(region);
  const redirectUri = `${publicBaseUrl(request)}/api/auth/coros/callback`;
  const existing = getCorosConnection();
  let clientId =
    existing &&
    existing.issuer === discovery.issuer &&
    existing.redirectUri === redirectUri &&
    existing.clientId
      ? existing.clientId
      : null;

  if (!clientId) {
    clientId = await registerClient(discovery.issuer, redirectUri);
  }
  saveCorosClient({
    region: discovery.region,
    issuer: discovery.issuer,
    mcpUrl: discovery.mcpUrl,
    clientId,
    redirectUri
  });

  const verifier = randomToken(32);
  const challenge = codeChallenge(verifier);
  const oauthState = randomToken(24);
  pendingSessions.set(oauthState, {
    ...discovery,
    clientId,
    redirectUri,
    verifier,
    createdAt: Date.now()
  });

  for (const [key, value] of pendingSessions) {
    if (Date.now() - value.createdAt > AUTH_SESSION_TTL_MS) pendingSessions.delete(key);
  }

  const authorizeUrl = new URL(discovery.authorizationEndpoint);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: discovery.mcpUrl,
    state: oauthState
  }).toString();

  return { authorizeUrl: authorizeUrl.toString(), region: discovery.region };
}

async function exchangeAuthorizationCode(session, code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: session.clientId,
    code,
    redirect_uri: session.redirectUri,
    code_verifier: session.verifier
  });
  return fetchJson(session.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
}

function persistTokenPayload(tokenPayload, session) {
  if (!tokenPayload.access_token) {
    throw errorWithCode("COROS_TOKEN_FAILED", "COROS 未返回访问令牌", 502);
  }
  const expiresAt = new Date(
    Date.now() + Number(tokenPayload.expires_in || 3600) * 1000
  ).toISOString();
  saveCorosClient({
    region: session.region,
    issuer: session.issuer,
    mcpUrl: session.mcpUrl,
    clientId: session.clientId,
    redirectUri: session.redirectUri
  });
  saveCorosTokens({
    encryptedAccessToken: encryptSecret(tokenPayload.access_token),
    encryptedRefreshToken: encryptSecret(tokenPayload.refresh_token || ""),
    tokenType: tokenPayload.token_type || "Bearer",
    scope: tokenPayload.scope || SCOPES,
    expiresAt
  });
}

export async function finishCorosAuthorization({ code, state }) {
  const session = pendingSessions.get(state);
  if (!session) {
    throw errorWithCode("COROS_STATE_INVALID", "授权会话已过期，请重新连接", 400);
  }
  pendingSessions.delete(state);
  const tokenPayload = await exchangeAuthorizationCode(session, code);
  persistTokenPayload(tokenPayload, session);
  return {
    region: session.region,
    mcpUrl: session.mcpUrl,
    expiresAt: getCorosConnection()?.expiresAt
  };
}

async function refreshAccessToken(connection) {
  if (!connection.encryptedRefreshToken) {
    throw errorWithCode("COROS_REAUTH_REQUIRED", "COROS 授权已过期，请重新连接", 401);
  }
  const refreshToken = decryptSecret(connection.encryptedRefreshToken);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: connection.clientId,
    refresh_token: refreshToken
  });
  try {
    const tokenPayload = await fetchJson(`${connection.issuer}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    persistTokenPayload(tokenPayload, {
      region: connection.region,
      issuer: connection.issuer,
      mcpUrl: connection.mcpUrl,
      clientId: connection.clientId,
      redirectUri: connection.redirectUri
    });
    return connectionTokenSnapshot(getCorosConnection());
  } catch (error) {
    clearCorosConnection();
    throw errorWithCode("COROS_REAUTH_REQUIRED", "COROS 授权已失效，请重新连接", 401);
  }
}

async function ensureAccessToken(forceRefresh = false) {
  const connection = getCorosConnection();
  if (!connection?.encryptedAccessToken) {
    throw errorWithCode("COROS_NOT_CONNECTED", "请先连接 COROS 账号", 401);
  }
  const expiresAt = connection.expiresAt ? new Date(connection.expiresAt).getTime() : 0;
  if (forceRefresh || expiresAt - Date.now() < 2 * 60 * 1000) {
    return refreshAccessToken(connection);
  }
  return connectionTokenSnapshot(connection);
}

function mcpHeaders(token) {
  return {
    Authorization: `${token.tokenType || "Bearer"} ${token.accessToken}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
  };
}

async function mcpRpc(token, id, method, params = {}, signal) {
  const payload = await fetchJson(token.mcpUrl, {
    method: "POST",
    headers: mcpHeaders(token),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    }),
    signal
  });
  if (payload.error) {
    throw errorWithCode(
      "COROS_MCP_ERROR",
      payload.error.message || "COROS MCP 调用失败",
      502
    );
  }
  if (!payload.result) {
    throw errorWithCode("COROS_MCP_ERROR", "COROS MCP 返回内容不完整", 502);
  }
  return payload.result;
}

async function initializeMcp(token, signal) {
  return mcpRpc(
    token,
    1,
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: CLIENT_NAME,
        version: "1.0.0"
      }
    },
    signal
  );
}

async function withMcpSession(callback, signal) {
  let token = await ensureAccessToken();
  try {
    await initializeMcp(token, signal);
    return await callback(token, signal);
  } catch (error) {
    if (error.status === 401 || error.code === "COROS_AUTH_EXPIRED") {
      token = await ensureAccessToken(true);
      await initializeMcp(token, signal);
      return callback(token, signal);
    }
    throw error;
  }
}

export async function listCorosTools() {
  return withMcpSession(async (token) => {
    const tools = [];
    let cursor = null;
    let requestId = 2;
    do {
      const result = await mcpRpc(
        token,
        requestId++,
        "tools/list",
        cursor ? { cursor } : {}
      );
      tools.push(...(result.tools || []));
      cursor = result.nextCursor || null;
    } while (cursor);
    return tools;
  });
}

function textContent(result) {
  return (result.content || [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n");
}

async function callTool(token, name, args, requestId = 2, signal) {
  const result = await mcpRpc(
    token,
    requestId,
    "tools/call",
    {
      name,
      arguments: args
    },
    signal
  );
  if (result.isError) {
    const content = textContent(result);
    throw errorWithCode("COROS_TOOL_ERROR", content || `COROS ${name} 调用失败`, 502);
  }
  return result;
}

function maybeJson(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectRecordArrays(value, results = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return results;
  seen.add(value);
  if (Array.isArray(value)) {
    if (
      value.length &&
      value.every(
        (item) =>
          item &&
          typeof item === "object" &&
          ["distance", "distanceKm", "distanceMeters", "duration", "startTime", "labelId"].some(
            (key) => key in item
          )
      )
    ) {
      results.push(value);
    }
    for (const item of value) collectRecordArrays(item, results, seen);
    return results;
  }
  for (const child of Object.values(value)) {
    collectRecordArrays(child, results, seen);
  }
  return results;
}

function parseJsonRecordText(text) {
  const parsed = maybeJson(text);
  let contentText = text;
  if (typeof parsed === "string") {
    contentText = parsed;
  } else if (parsed) {
    return collectRecordArrays(parsed).flat();
  }
  contentText = contentText
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"');
  const records = [];
  const blocks = contentText.split(/\n(?=\d+\.\s+)/);
  for (const block of blocks) {
    const titleMatch = block.match(
      /^\s*\d+\.\s+(.+?)\s*[—-]\s*\d{4}-\d{2}-\d{2}/m
    );
    const typeMatch = block.match(/(?:Sport\((\d+)\)|SportType:\s*(\d+))/i);
    const dateMatch = block.match(/(\d{4}-\d{2}-\d{2})/);
    const durationMatch = block.match(/Duration:\s*([\d:]+)/i);
    const distanceMatch = block.match(/Distance:\s*([\d.]+)\s*km/i);
    const paceMatch = block.match(/Average Pace:\s*([\d:]+)/i);
    const heartRateMatch = block.match(/(?:Average Heart Rate|Avg\.? HR):\s*(\d+)/i);
    const labelIdMatch = block.match(/LabelId:\s*([A-Za-z0-9_-]+)/i);
    const startTimestampMatch = block.match(/startTimestamp=(\d+)/i);
    const endTimestampMatch = block.match(/endTimestamp=(\d+)/i);
    const locationMatch = block.match(/Location:\s*(.+)/i);
    if (!dateMatch || !durationMatch || !distanceMatch) continue;
    records.push({
      sportType: Number(typeMatch?.[1] || typeMatch?.[2]) || null,
      sportName: titleMatch?.[1]?.trim() || null,
      labelId: labelIdMatch?.[1] || null,
      startTimestamp: startTimestampMatch?.[1] || null,
      endTimestamp: endTimestampMatch?.[1] || null,
      location: locationMatch?.[1]?.trim() || null,
      startDate: dateMatch[1],
      duration: durationMatch[1],
      distanceKm: Number(distanceMatch[1]),
      avgPace: paceMatch?.[1] || null,
      avgHr: heartRateMatch?.[1] || null
    });
  }
  return records;
}

export function extractCorosToolRecords(result) {
  const candidates = [];
  if (result.structuredContent) {
    candidates.push(...collectRecordArrays(result.structuredContent).flat());
  }
  const text = textContent(result);
  if (text) candidates.push(...parseJsonRecordText(text));
  return candidates;
}

function getKey(record, keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return null;
}

function asNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function secondsFrom(value) {
  if (typeof value === "number") return value;
  const number = asNumber(value);
  if (number !== null) return number;
  const parts = String(value || "").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function dateFrom(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = String(value).trim();
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (/^\d{8}$/.test(text)) {
    return new Date(
      `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T07:00:00+08:00`
    ).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T07:00:00+08:00`).toISOString();
  }
  const naive = text.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/
  );
  if (naive) {
    return new Date(`${naive[1]}T${naive[2]}+08:00`).toISOString();
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sportIdentity(record) {
  const type = asNumber(
    getKey(record, ["sportType", "sport_type", "sportTypeCode"])
  );
  const name = [
    getKey(record, [
      "sportName",
      "sport_name",
      "sportTypeName",
      "activityType",
      "typeName",
      "name",
      "title",
      "activityName"
    ]),
    getKey(record, ["location", "locationName", "place"])
  ]
    .filter((item) => item !== undefined && item !== null && item !== "")
    .join(" ");
  return { type, name };
}

export function isRunningCorosRecord(record) {
  const { type, name } = sportIdentity(record);
  if (name) {
    if (RUNNING_NAME.test(name)) return true;
    if (NON_RUNNING_NAME.test(name)) return false;
  }
  if (type !== null) {
    if (RUNNING_SPORT_TYPES.has(type)) return true;
    if (NON_RUNNING_SPORT_TYPES.has(type)) return false;
  }
  return true;
}

function metersFrom(record) {
  const km = asNumber(getKey(record, ["distanceKm", "distance_km", "kilometers"]));
  if (km !== null) return km * 1000;
  const meters = asNumber(
    getKey(record, ["distanceMeters", "distance_meters", "distanceM", "distance_m"])
  );
  if (meters !== null) return meters;
  const distance = asNumber(getKey(record, ["distance", "totalDistance"]));
  if (distance === null) return null;
  return distance > 100 ? distance : distance * 1000;
}

export function normalizeCorosRecord(record) {
  const startedAt = dateFrom(
    getKey(record, [
      "startTime",
      "start_time",
      "startTimestamp",
      "start_timestamp",
      "startDate",
      "start_date",
      "date"
    ])
  );
  const distanceM = metersFrom(record);
  const durationSec = secondsFrom(
    getKey(record, ["durationSec", "duration", "durationSeconds", "workoutTime", "time"])
  );
  if (!startedAt || !distanceM || distanceM <= 0 || !durationSec || durationSec <= 0) {
    return null;
  }

  const labelId = getKey(record, ["labelId", "label_id", "activityId", "activity_id", "id"]);
  const sportType = getKey(record, ["sportType", "sport_type", "sportTypeCode"]);
  const sportName =
    getKey(record, ["sportName", "sport_name", "sportTypeName", "activityType", "typeName"]) ||
    getKey(record, ["location", "locationName", "place"]) ||
    "COROS 跑步";
  const pace = secondsFrom(getKey(record, ["avgPace", "avg_pace", "averagePace", "pace"]));
  const externalId = labelId ? `coros:${labelId}` : `coros:${compactHash(`${startedAt}|${distanceM}|${durationSec}`)}`;

  return {
    provider: "coros",
    externalId,
    startedAt,
    durationSec,
    distanceM,
    avgPaceSecPerKm: pace || Math.round(durationSec / (distanceM / 1000)),
    avgHeartRate: asNumber(
      getKey(record, ["avgHr", "avgHR", "averageHeartRate", "avgHeartRate", "heartRate"])
    ),
    maxHeartRate: asNumber(getKey(record, ["maxHr", "maxHR", "maxHeartRate"])),
    cadence: asNumber(getKey(record, ["avgCadence", "cadence", "averageCadence"])),
    elevationGainM: asNumber(getKey(record, ["elevGain", "elevationGain", "totalAscent"])),
    trainingLoad: asNumber(getKey(record, ["trainingLoad", "load"])),
    raw: {
      title: sportName,
      labelId: labelId ? String(labelId) : null,
      sportType: sportType === null ? null : String(sportType),
      location: getKey(record, ["location", "locationName", "place"]),
      source: "COROS MCP"
    }
  };
}

function mergeDetail(activity, result) {
  const structured = result.structuredContent ? collectRecordArrays(result.structuredContent).flat()[0] : null;
  if (structured) {
    const avgHr = asNumber(
      getKey(structured, ["avgHr", "avgHR", "averageHeartRate", "avgHeartRate"])
    );
    const maxHr = asNumber(getKey(structured, ["maxHr", "maxHR", "maxHeartRate"]));
    const cadence = asNumber(getKey(structured, ["avgCadence", "cadence"]));
    if (avgHr) activity.avgHeartRate = avgHr;
    if (maxHr) activity.maxHeartRate = maxHr;
    if (cadence) activity.cadence = cadence;
  }

  const text = textContent(result);
  const avgHr = text.match(/Average Heart Rate:\s*(\d+)/i);
  const maxHr = text.match(/Max(?:imum)? Heart Rate:\s*(\d+)/i);
  const cadence = text.match(/Cadence:\s*(\d+)/i);
  if (avgHr) activity.avgHeartRate = Number(avgHr[1]);
  if (maxHr) activity.maxHeartRate = Number(maxHr[1]);
  if (cadence) activity.cadence = Number(cadence[1]);
  return activity;
}

function compactDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export async function syncCorosActivities(days = 30, { signal } = {}) {
  const safeDays = Math.min(90, Math.max(1, Number(days) || 30));
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - safeDays);

  return withMcpSession(async (token, sessionSignal) => {
    const result = await callTool(
      token,
      "querySportRecords",
      {
        startDate: compactDate(start),
        endDate: compactDate(end),
        limit: 50
      },
      2,
      sessionSignal
    );
    const records = extractCorosToolRecords(result);
    const runningRecords = records.filter(isRunningCorosRecord);
    const activities = runningRecords.map(normalizeCorosRecord).filter(Boolean);
    const detailed = [];
    let requestId = 3;

    for (const activity of activities.slice(0, 12)) {
      if (sessionSignal?.aborted) {
        const cancelled = new Error("操作已取消");
        cancelled.code = "RUN_CANCELLED";
        throw cancelled;
      }
      if (!activity.raw.labelId || !activity.raw.sportType) {
        detailed.push(activity);
        continue;
      }
      try {
        const detail = await callTool(
          token,
          "getActivityDetail",
          {
            labelId: activity.raw.labelId,
            sportType: Number(activity.raw.sportType)
          },
          requestId++,
          sessionSignal
        );
        detailed.push(mergeDetail(activity, detail));
      } catch {
        detailed.push(activity);
      }
    }
    detailed.push(...activities.slice(12));
    updateCorosSyncTime();
    return {
      activities: detailed,
      recordCount: records.length,
      ignoredCount: records.length - runningRecords.length
    };
  }, signal);
}

export async function createCorosScheduledWorkout(date, course, { signal } = {}) {
  return withMcpSession(async (token, sessionSignal) => {
    const result = await callTool(
      token,
      "createScheduledWorkout",
      { date, course },
      2,
      sessionSignal
    );
    return {
      ok: !result.isError,
      content: textContent(result),
      structuredContent: result.structuredContent || null
    };
  });
}

export function corosStatus() {
  const connection = getCorosConnection();
  if (!connection) {
    return {
      connected: false,
      regions: Object.entries(COROS_REGIONS).map(([id, value]) => ({ id, label: value.label }))
    };
  }
  return {
    connected: Boolean(connection.encryptedAccessToken),
    connectedAt: connection.createdAt,
    lastSyncAt: connection.lastSyncAt,
    expiresAt: connection.expiresAt,
    region: connection.region,
    issuer: connection.issuer,
    mcpUrl: connection.mcpUrl,
    regions: Object.entries(COROS_REGIONS).map(([id, value]) => ({ id, label: value.label }))
  };
}

export async function disconnectCoros() {
  const connection = getCorosConnection();
  if (connection?.encryptedAccessToken) {
    try {
      const token = connectionTokenSnapshot(connection);
      await fetchJson(connection.revocationEndpoint || `${connection.issuer}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: token.accessToken,
          client_id: connection.clientId
        })
      });
    } catch {
      // Local credentials are still removed even if remote revocation is unavailable.
    }
  }
  clearCorosConnection();
  return { disconnected: true };
}
