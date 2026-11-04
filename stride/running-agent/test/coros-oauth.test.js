import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "stride-coros-oauth-test-"));
process.env.DB_PATH = path.join(tempDir, "coros-oauth.db");
process.env.SEED_DEMO = "false";
delete process.env.PUBLIC_BASE_URL;
process.env.RENDER_EXTERNAL_URL = "https://stride-demo.onrender.com";

const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({
    url: String(url),
    method: options.method || "GET",
    body: options.body ? JSON.parse(String(options.body)) : null
  });
  if (String(url).endsWith("/.well-known/openid-configuration")) {
    return jsonResponse({
      issuer: "https://mcp.coros.com",
      authorization_endpoint: "https://mcp.coros.com/oauth2/authorize",
      token_endpoint: "https://mcp.coros.com/oauth2/token"
    });
  }
  if (String(url).endsWith("/connect/register")) {
    return jsonResponse({ client_id: "render-test-client" });
  }
  throw new Error(`Unexpected COROS test request: ${url}`);
};

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

const { startCorosAuthorization } = await import("../src/coros.js");
const { db } = await import("../src/db.js");

after(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.RENDER_EXTERNAL_URL;
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("uses the Render public URL for the COROS OAuth callback", async () => {
  const result = await startCorosAuthorization(
    {
      protocol: "http",
      get(name) {
        return name === "host" ? "internal:4173" : "";
      }
    },
    "global"
  );

  const registration = requests.find((request) =>
    request.url.endsWith("/connect/register")
  );
  assert.deepEqual(registration.body.redirect_uris, [
    "https://stride-demo.onrender.com/api/auth/coros/callback"
  ]);

  const authorizeUrl = new URL(result.authorizeUrl);
  assert.equal(
    authorizeUrl.searchParams.get("redirect_uri"),
    "https://stride-demo.onrender.com/api/auth/coros/callback"
  );
});
