import {
  MEMORY_TYPES,
  checkInTrainingSession,
  clearSessionMessages,
  createMemory,
  createSession,
  deleteMemory,
  deleteSession,
  getAgentRun,
  getRunnerProfile,
  getSession,
  listAgentSteps,
  listMemories,
  listSessionMessages,
  listSessions,
  listTrainingSessions,
  saveRunnerProfile,
  sessionMemoryStats,
  updateMemory,
  updateSession
} from "./agent-store.js";
import {
  cancelAgentRun,
  getRunDetails,
  startAgentRun,
  subscribeRun
} from "./agent-runtime.js";
import { executeAgentTool } from "./agent-tools.js";
import {
  normalizeModelConfig,
  validateModelConfig
} from "./model-gateway.js";
import {
  cancelJob,
  enqueueJob,
  retryJob
} from "./job-runner.js";
import { listJobs } from "./agent-store.js";

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function weekRange(query = {}) {
  const now = new Date();
  const start = query.start ? new Date(`${query.start}T12:00:00`) : now;
  if (!query.start) {
    const weekday = start.getDay() === 0 ? 6 : start.getDay() - 1;
    start.setDate(start.getDate() - weekday);
  }
  const end = query.end ? new Date(`${query.end}T12:00:00`) : new Date(start);
  if (!query.end) end.setDate(end.getDate() + 6);
  return { start: dateOnly(start), end: dateOnly(end) };
}

function requiredModel(body) {
  const config = normalizeModelConfig(body.model || {});
  validateModelConfig(config);
  return config;
}

export function registerAgentRoutes(app, { asyncRoute, httpError }) {
  app.get("/api/sessions", (request, response) => {
    response.json({ sessions: listSessions() });
  });

  app.post("/api/sessions", (request, response) => {
    response.status(201).json({
      session: createSession(String(request.body?.title || "新训练对话"))
    });
  });

  app.patch("/api/sessions/:id", (request, response) => {
    const session = updateSession(request.params.id, {
      title: request.body?.title
    });
    if (!session) throw httpError(404, "SESSION_NOT_FOUND", "会话不存在");
    response.json({ session });
  });

  app.delete("/api/sessions/:id", (request, response) => {
    const deleted = deleteSession(request.params.id);
    if (!deleted) throw httpError(404, "SESSION_NOT_FOUND", "会话不存在");
    response.json({ deleted: true });
  });

  app.get("/api/sessions/:id/messages", (request, response) => {
    if (!getSession(request.params.id)) {
      throw httpError(404, "SESSION_NOT_FOUND", "会话不存在");
    }
    const limit = Math.min(200, Math.max(1, Number(request.query.limit || 100)));
    response.json({
      messages: listSessionMessages(request.params.id, limit)
    });
  });

  app.delete("/api/sessions/:id/messages", (request, response) => {
    if (!getSession(request.params.id)) {
      throw httpError(404, "SESSION_NOT_FOUND", "会话不存在");
    }
    response.json({
      deleted: clearSessionMessages(request.params.id)
    });
  });

  app.get("/api/sessions/:id/context", (request, response) => {
    if (!getSession(request.params.id)) {
      throw httpError(404, "SESSION_NOT_FOUND", "会话不存在");
    }
    response.json({
      context: sessionMemoryStats(request.params.id)
    });
  });

  app.get("/api/profile", (request, response) => {
    response.json({ profile: getRunnerProfile() });
  });

  app.put("/api/profile", (request, response) => {
    response.json({ profile: saveRunnerProfile(request.body || {}) });
  });

  app.get("/api/memory", (request, response) => {
    response.json({ memories: listMemories(200) });
  });

  app.post("/api/memory", (request, response) => {
    const content = String(request.body?.content || "").trim();
    if (!content) throw httpError(400, "MEMORY_CONTENT_REQUIRED", "记忆内容不能为空");
    const type = String(request.body?.type || "preference");
    if (!MEMORY_TYPES.has(type)) {
      throw httpError(400, "MEMORY_TYPE_INVALID", "记忆类型无效");
    }
    response.status(201).json({
      memory: createMemory({
        type,
        content,
        importance: request.body?.importance,
        source: "manual"
      })
    });
  });

  app.patch("/api/memory/:id", (request, response) => {
    if (
      request.body?.type !== undefined &&
      !MEMORY_TYPES.has(String(request.body.type))
    ) {
      throw httpError(400, "MEMORY_TYPE_INVALID", "记忆类型无效");
    }
    if (
      request.body?.content !== undefined &&
      !String(request.body.content).trim()
    ) {
      throw httpError(400, "MEMORY_CONTENT_REQUIRED", "记忆内容不能为空");
    }
    const memory = updateMemory(request.params.id, request.body || {});
    if (!memory) throw httpError(404, "MEMORY_NOT_FOUND", "记忆不存在");
    response.json({ memory });
  });

  app.delete("/api/memory/:id", (request, response) => {
    if (!deleteMemory(request.params.id)) {
      throw httpError(404, "MEMORY_NOT_FOUND", "记忆不存在");
    }
    response.json({ deleted: true });
  });

  app.get("/api/training/calendar", (request, response) => {
    const range = weekRange(request.query);
    response.json({
      ...range,
      sessions: listTrainingSessions(range)
    });
  });

  app.post(
    "/api/training/calendar/:id/check-in",
    (request, response) => {
      if (!checkInTrainingSession(request.params.id, request.body || {})) {
        throw httpError(404, "TRAINING_SESSION_NOT_FOUND", "课程不存在");
      }
      response.json({ ok: true });
    }
  );

  app.post(
    "/api/agent/runs",
    asyncRoute(async (request, response) => {
      const question = String(request.body?.question || "").trim();
      const sessionId = String(request.body?.sessionId || "").trim();
      if (!question) throw httpError(400, "QUESTION_REQUIRED", "请输入训练问题");
      if (question.length > 2000) {
        throw httpError(400, "QUESTION_TOO_LONG", "问题不能超过 2000 个字符");
      }
      if (!sessionId) throw httpError(400, "SESSION_REQUIRED", "请选择会话");
      if (!getSession(sessionId)) {
        throw httpError(404, "SESSION_NOT_FOUND", "会话不存在");
      }
      const config = requiredModel(request.body);
      response.status(202).json(startAgentRun({ sessionId, question, config }));
    })
  );

  app.get("/api/agent/runs/:id", (request, response) => {
    const run = getRunDetails(request.params.id);
    if (!run) throw httpError(404, "RUN_NOT_FOUND", "运行记录不存在");
    response.json({ run });
  });

  app.get("/api/agent/runs/:id/context", (request, response) => {
    const run = getRunDetails(request.params.id);
    if (!run) throw httpError(404, "RUN_NOT_FOUND", "运行记录不存在");
    response.json({
      context: run.context,
      promptVersion: run.promptVersion,
      usage: run.usage,
      steps: run.steps
    });
  });

  app.get("/api/agent/runs/:id/events", (request, response) => {
    if (!subscribeRun(request.params.id, response)) {
      throw httpError(404, "RUN_NOT_FOUND", "运行记录不存在");
    }
  });

  app.post("/api/agent/runs/:id/cancel", (request, response) => {
    if (!cancelAgentRun(request.params.id)) {
      throw httpError(409, "RUN_NOT_CANCELLABLE", "当前运行无法取消");
    }
    response.json({ cancelled: true });
  });

  app.post(
    "/api/agent/runs/:id/retry",
    asyncRoute(async (request, response) => {
      const run = getAgentRun(request.params.id);
      if (!run) throw httpError(404, "RUN_NOT_FOUND", "运行记录不存在");
      if (!["failed", "cancelled"].includes(run.status)) {
        throw httpError(
          409,
          "RUN_NOT_RETRYABLE",
          "只有失败或已取消的运行可以重试"
        );
      }
      const config = requiredModel(request.body);
      response.status(202).json(
        startAgentRun({
          sessionId: run.sessionId,
          question: run.question,
          config,
          recordQuestion: false
        })
      );
    })
  );

  app.post(
    "/api/tools/preview-plan-write",
    asyncRoute(async (request, response) => {
      const result = await executeAgentTool(
        "previewPlanWrite",
        request.body || {},
        { runId: request.body?.runId || null }
      );
      response.json(result);
    })
  );

  app.post(
    "/api/tools/publish-plan",
    asyncRoute(async (request, response) => {
      const result = await executeAgentTool(
        "publishPlan",
        { confirmationToken: request.body?.confirmationToken },
        { runId: request.body?.runId || null }
      );
      response.json(result);
    })
  );

  app.get("/api/jobs", (request, response) => {
    response.json({ jobs: listJobs(50) });
  });

  app.post("/api/jobs/sync", (request, response) => {
    const source = String(request.body?.source || "coros");
    if (source !== "coros") {
      throw httpError(400, "SOURCE_UNSUPPORTED", "暂不支持该数据源");
    }
    const days = Math.max(1, Math.min(90, Number(request.body?.days) || 30));
    response.status(202).json({
      job: enqueueJob({
        type: "sync-coros",
        payload: { days },
        idempotencyKey: `sync-coros:${days}:${new Date().toISOString().slice(0, 13)}`
      })
    });
  });

  app.post("/api/jobs/:id/cancel", (request, response) => {
    if (!cancelJob(request.params.id)) {
      throw httpError(409, "JOB_NOT_CANCELLABLE", "当前任务无法取消");
    }
    response.json({ cancelled: true });
  });

  app.post("/api/jobs/:id/retry", (request, response) => {
    const job = retryJob(request.params.id);
    if (!job) throw httpError(404, "JOB_NOT_FOUND", "任务不存在");
    response.status(202).json({ job });
  });
}
