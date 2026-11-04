import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  optionalAuthMiddleware,
  registerAuthRoutes
} from "../src/auth.js";
import { validateModelBaseUrlSafety } from "../src/model-gateway.js";
import { originGuard } from "../src/origin-guard.js";

test("optional password protects API routes and accepts valid login", async () => {
  process.env.APP_PASSWORD = "test-password";
  const app = express();
  app.use(express.json());
  const httpError = (status, code, message) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
  };
  registerAuthRoutes(app, { httpError });
  app.use(optionalAuthMiddleware);
  app.get("/api/protected", (request, response) => response.json({ ok: true }));
  app.use((error, request, response, next) =>
    response.status(error.status || 500).json({ code: error.code, message: error.message })
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const denied = await fetch(`${baseUrl}/api/protected`);
    assert.equal(denied.status, 401);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const allowed = await fetch(`${baseUrl}/api/protected`, {
      headers: { cookie }
    });
    assert.equal(allowed.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.APP_PASSWORD;
  }
});

test("blocks cross-origin state-changing API requests", async () => {
  const app = express();
  app.use(express.json());
  app.use(originGuard());
  app.post("/api/write", (request, response) => response.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const denied = await fetch(`${baseUrl}/api/write`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example"
      },
      body: "{}"
    });
    assert.equal(denied.status, 403);
    const sameOrigin = await fetch(`${baseUrl}/api/write`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: "{}"
    });
    assert.equal(sameOrigin.status, 200);
    const noOrigin = await fetch(`${baseUrl}/api/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(noOrigin.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("can block private model Base URLs for SSRF protection", async () => {
  process.env.BLOCK_PRIVATE_MODEL_URLS = "true";
  try {
    await assert.rejects(
      validateModelBaseUrlSafety({
        baseUrl: "http://127.0.0.1:11434/v1"
      }),
      (error) => error.code === "MODEL_BASE_URL_BLOCKED"
    );
  } finally {
    delete process.env.BLOCK_PRIVATE_MODEL_URLS;
  }
});
