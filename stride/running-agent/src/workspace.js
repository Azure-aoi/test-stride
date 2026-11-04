import { randomUUID } from "node:crypto";
import { ensureUserInitialized, runAsUser } from "./db.js";
import { ensureUserSession } from "./agent-store.js";

const WORKSPACE_COOKIE = "stride_workspace";
const WORKSPACE_PATTERN =
  /^guest-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function workspaceIdFor(request) {
  const existing = parseCookies(request.headers.cookie)[WORKSPACE_COOKIE];
  return WORKSPACE_PATTERN.test(existing || "") ? existing : `guest-${randomUUID()}`;
}

export function workspaceMiddleware(request, response, next) {
  const existing = parseCookies(request.headers.cookie)[WORKSPACE_COOKIE];
  const userId = workspaceIdFor(request);

  if (userId !== existing) {
    response.append(
      "Set-Cookie",
      [
        `${WORKSPACE_COOKIE}=${encodeURIComponent(userId)}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        ...(request.secure ? ["Secure"] : [])
      ].join("; ")
    );
  }

  runAsUser(userId, () => {
    ensureUserInitialized();
    ensureUserSession();
    next();
  });
}
