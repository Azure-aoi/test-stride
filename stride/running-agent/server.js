import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { DEFAULT_USER_ID, activityCount } from "./src/db.js";
import { corosStatus } from "./src/coros.js";
import { registerAgentRoutes } from "./src/agent-api.js";
import { failInterruptedRuns, pruneAgentAudit } from "./src/agent-store.js";
import { originGuard } from "./src/origin-guard.js";
import { enqueueJob, recoverJobs } from "./src/job-runner.js";
import {
  optionalAuthMiddleware,
  registerAuthRoutes
} from "./src/auth.js";
import { registerDataRoutes } from "./src/api/data-routes.js";
import { registerCorosRoutes } from "./src/api/coros-routes.js";
import { registerModelRoutes } from "./src/api/model-routes.js";
import { workspaceMiddleware } from "./src/workspace.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(workspaceMiddleware);
app.use((request, response, next) => {
  if (request.path.startsWith("/api/")) {
    response.setHeader("Cache-Control", "no-store");
  }
  next();
});
app.use(originGuard());

function asyncRoute(handler) {
  return (request, response, next) =>
    Promise.resolve(handler(request, response, next)).catch(next);
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

registerAuthRoutes(app, { httpError });
app.use(optionalAuthMiddleware);
registerAgentRoutes(app, { asyncRoute, httpError });
registerDataRoutes(app, { asyncRoute, httpError, upload });
registerCorosRoutes(app, { asyncRoute, httpError });
registerModelRoutes(app, { asyncRoute, httpError });

recoverJobs();
failInterruptedRuns();
const auditRetentionDays = Number(process.env.AUDIT_RETENTION_DAYS || 90);
pruneAgentAudit({ days: auditRetentionDays });
const auditTimer = setInterval(
  () => pruneAgentAudit({ days: auditRetentionDays }),
  24 * 60 * 60 * 1000
);
auditTimer.unref();
const autoSyncMinutes = Number(process.env.AUTO_SYNC_MINUTES || 0);
if (Number.isFinite(autoSyncMinutes) && autoSyncMinutes > 0) {
  const timer = setInterval(() => {
    if (!corosStatus().connected) return;
    enqueueJob({
      type: "sync-coros",
      payload: { days: 30 },
      idempotencyKey: `auto-sync:${Math.floor(
        Date.now() / (autoSyncMinutes * 60_000)
      )}`
    });
  }, autoSyncMinutes * 60_000);
  timer.unref();
}

app.use("/api", (request, response) => {
  response.status(404).json({
    error: {
      code: "API_NOT_FOUND",
      message: "接口不存在",
      retryable: false
    }
  });
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.use((request, response, next) => {
  if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
  response.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    return response.status(400).json({
      error: {
        code: error.code,
        message:
          error.code === "LIMIT_FILE_SIZE" ? "文件不能超过 10 MB" : "文件上传失败",
        retryable: false
      }
    });
  }
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  const exposeMessage = status < 500 || error.expose === true;
  response.status(status).json({
    error: {
      code: error.code || "INTERNAL_ERROR",
      message: exposeMessage ? error.message : "服务暂时不可用，请稍后重试",
      retryable: status >= 500
    }
  });
});

const server = app.listen(port, host, () => {
  const displayHost = ["0.0.0.0", "::"].includes(host) ? "localhost" : host;
  console.log(`STRIDE OS running at http://${displayHost}:${port}`);
  console.log(`Activities in local database: ${activityCount()}`);
});

const sockets = new Set();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

function shutdown() {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { app, DEFAULT_USER_ID };
