import {
  createJob,
  getJob,
  listJobs,
  updateJob
} from "./agent-store.js";
import { syncCorosActivities } from "./coros.js";
import { removeDemoActivities, saveActivities } from "./db.js";

const running = new Map();
const controllers = new Map();

async function executeJob(job, signal) {
  if (job.type !== "sync-coros") {
    throw new Error(`不支持的任务类型：${job.type}`);
  }
  updateJob(job.id, {
    status: "running",
    progress: 0.1,
    startedAt: new Date().toISOString()
  });
  const days = Math.max(1, Math.min(90, Number(job.payload?.days) || 30));
  const result = await syncCorosActivities(days);
  if (signal.aborted) throw new Error("任务已取消");
  updateJob(job.id, { progress: 0.75 });
  if (!result.activities.length) {
    const completed = updateJob(job.id, {
      status: "completed",
      progress: 1,
      result: { imported: 0, updated: 0, skipped: 0, fetched: result.recordCount },
      endedAt: new Date().toISOString()
    });
    return completed;
  }
  const saved = saveActivities(result.activities, null, { updateExisting: true });
  if (saved.inserted > 0) removeDemoActivities();
  return updateJob(job.id, {
    status: "completed",
    progress: 1,
    result: {
      imported: saved.inserted,
      updated: saved.updated,
      skipped: saved.skipped,
      fetched: result.recordCount
    },
    endedAt: new Date().toISOString()
  });
}

async function runQueuedJob(job) {
  if (running.has(job.id)) return running.get(job.id);
  const controller = new AbortController();
  controllers.set(job.id, controller);
  const promise = (async () => {
    try {
      return await executeJob(job, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || getJob(job.id)?.status === "cancelled") {
        return getJob(job.id);
      }
      return updateJob(job.id, {
        status: "failed",
        error: error.message,
        endedAt: new Date().toISOString()
      });
    } finally {
      running.delete(job.id);
      controllers.delete(job.id);
    }
  })();
  running.set(job.id, promise);
  return promise;
}

export function enqueueJob({ type, payload = {}, idempotencyKey = null }) {
  const job = createJob({ type, payload, idempotencyKey });
  if (["queued", "failed"].includes(job.status)) {
    runQueuedJob(job);
  }
  return job;
}

export function cancelJob(id) {
  const job = getJob(id);
  if (!job || !["queued", "running"].includes(job.status)) return false;
  controllers.get(id)?.abort();
  updateJob(id, {
    status: "cancelled",
    error: "用户取消任务",
    endedAt: new Date().toISOString()
  });
  return true;
}

export function retryJob(id) {
  const job = getJob(id);
  if (!job) return null;
  const next = createJob({
    type: job.type,
    payload: job.payload,
    idempotencyKey: job.idempotencyKey ? `${job.idempotencyKey}:retry:${Date.now()}` : null
  });
  runQueuedJob(next);
  return next;
}

export function recoverJobs() {
  const jobs = listJobs(100);
  for (const job of jobs) {
    if (job.status === "queued") runQueuedJob(job);
    if (job.status === "running") {
      const recovered = updateJob(job.id, {
        status: "queued",
        progress: 0,
        error: null
      });
      runQueuedJob(recovered);
    }
  }
}
