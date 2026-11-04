import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const sessions = new Map();
const attempts = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function hash(value) {
  return createHash("sha256").update(String(value)).digest();
}

function passwordMatches(input) {
  const expected = hash(process.env.APP_PASSWORD);
  const actual = hash(input);
  return timingSafeEqual(expected, actual);
}

function parseCookies(header = "") {
  const result = {};
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function currentToken(request) {
  return parseCookies(request.headers.cookie).stride_auth || "";
}

function sessionValid(token) {
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function loginBlocked(ip) {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= Date.now()) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const now = Date.now();
  const existing = attempts.get(ip);
  if (!existing || existing.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  existing.count += 1;
}

export function authRequired() {
  return Boolean(String(process.env.APP_PASSWORD || "").trim());
}

export function isAuthenticated(request) {
  if (!authRequired()) return true;
  return sessionValid(currentToken(request));
}

export function optionalAuthMiddleware(request, response, next) {
  if (!authRequired()) return next();
  if (!request.path.startsWith("/api/")) return next();
  if (
    request.path === "/api/health" ||
    request.path.startsWith("/api/auth/")
  ) {
    return next();
  }
  if (!isAuthenticated(request)) {
    const error = new Error("请先登录");
    error.code = "AUTH_REQUIRED";
    error.status = 401;
    return next(error);
  }
  next();
}

export function registerAuthRoutes(app, { httpError }) {
  app.get("/api/auth/status", (request, response) => {
    response.json({
      required: authRequired(),
      authenticated: isAuthenticated(request)
    });
  });

  app.post("/api/auth/login", (request, response) => {
    if (!authRequired()) {
      response.json({ authenticated: true, required: false });
      return;
    }
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    if (loginBlocked(ip)) {
      throw httpError(429, "AUTH_RATE_LIMITED", "登录尝试过多，请稍后再试");
    }
    const password = String(request.body?.password || "");
    if (!passwordMatches(password)) {
      recordFailure(ip);
      throw httpError(401, "AUTH_INVALID", "访问口令错误");
    }
    attempts.delete(ip);
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    const secure =
      request.secure ||
      String(process.env.PUBLIC_BASE_URL || "").startsWith("https://");
    response.setHeader(
      "Set-Cookie",
      [
        `stride_auth=${encodeURIComponent(token)}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        ...(secure ? ["Secure"] : [])
      ].join("; ")
    );
    response.json({ authenticated: true, required: true });
  });

  app.post("/api/auth/logout", (request, response) => {
    const token = currentToken(request);
    if (token) sessions.delete(token);
    response.setHeader(
      "Set-Cookie",
      "stride_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    );
    response.json({ authenticated: false });
  });
}
