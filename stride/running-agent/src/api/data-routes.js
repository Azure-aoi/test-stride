import path from "node:path";
import { createHash } from "node:crypto";
import {
  corosActivityCount,
  createImport,
  deleteActivity,
  deleteImport,
  finishImport,
  getActivity,
  listActivities,
  listImports,
  removeDemoActivities,
  renameActivity,
  resetDemoData,
  saveActivities
} from "../db.js";
import { calculateDashboard } from "../metrics.js";
import { parseImportFile } from "../parsers.js";
import { corosStatus } from "../coros.js";

const TEMPLATE = [
  "started_at,distance_km,duration_sec,avg_pace_sec_per_km,avg_heart_rate,max_heart_rate,cadence,notes",
  "2026-11-01T07:30:00+08:00,10,3120,312,156,178,176,周末长距离",
  "2026-10-29T19:10:00+08:00,5,1580,316,148,171,174,轻松跑"
].join("\n");

function dataSummary() {
  const activities = listActivities({ limit: 1000 });
  const demoCount = activities.filter((item) => item.provider === "demo").length;
  return {
    activityCount: activities.length,
    demoCount,
    hasRealData: activities.some((item) => item.provider !== "demo")
  };
}

export function registerDataRoutes(app, { asyncRoute, httpError, upload }) {
  app.get("/api/health", (request, response) => {
    response.json({ ok: true, service: "stride-os", node: process.version });
  });

  app.get("/api/dashboard", (request, response) => {
    const allowedDays = [7, 28, 56, 90];
    const requestedDays = Number(request.query.days || 28);
    const days = allowedDays.includes(requestedDays) ? requestedDays : 28;
    const activities = listActivities({ limit: 1000 });
    response.json({
      dashboard: calculateDashboard(activities, days),
      activities: activities.slice(0, 40),
      imports: listImports(10),
      data: dataSummary()
    });
  });

  app.get("/api/activities", (request, response) => {
    const limit = Math.min(200, Math.max(1, Number(request.query.limit || 50)));
    response.json({ activities: listActivities({ limit }) });
  });

  app.get("/api/activities/:id", (request, response) => {
    const activity = getActivity(request.params.id);
    if (!activity) {
      throw httpError(404, "ACTIVITY_NOT_FOUND", "找不到这条训练记录");
    }
    response.json({ activity });
  });

  app.patch("/api/activities/:id", (request, response) => {
    const title = String(request.body?.title || "").trim();
    if (!title) {
      throw httpError(400, "ACTIVITY_TITLE_REQUIRED", "请输入训练名称");
    }
    if (title.length > 80) {
      throw httpError(400, "ACTIVITY_TITLE_TOO_LONG", "训练名称不能超过 80 个字符");
    }
    const activity = renameActivity(request.params.id, title);
    if (!activity) {
      throw httpError(404, "ACTIVITY_NOT_FOUND", "找不到这条训练记录");
    }
    response.json({ activity });
  });

  app.delete("/api/activities/:id", (request, response) => {
    const result = deleteActivity(request.params.id);
    if (!result) {
      throw httpError(404, "ACTIVITY_NOT_FOUND", "找不到这条训练记录");
    }
    response.json(result);
  });

  app.get("/api/sources", (request, response) => {
    const coros = corosStatus();
    response.json({
      sources: [
        {
          id: "upload",
          name: "文件上传",
          shortName: "UPLOAD",
          status: "available",
          detail: "CSV、GPX、TCX"
        },
        {
          id: "coros",
          name: "高驰 COROS",
          shortName: "COROS",
          status: coros.connected ? "connected" : "authorization_required",
          detail: coros.connected
            ? `已连接 · ${corosActivityCount()} 条活动`
            : "通过 OAuth 连接"
        }
      ]
    });
  });

  app.get("/api/imports/template.csv", (request, response) => {
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="stride-import-template.csv"'
    );
    response.send(String.fromCharCode(0xfeff) + TEMPLATE);
  });

  app.get("/api/imports", (request, response) => {
    response.json({ imports: listImports(20) });
  });

  app.post(
    "/api/imports/files",
    upload.single("file"),
    asyncRoute(async (request, response) => {
      if (!request.file) throw httpError(400, "FILE_REQUIRED", "请选择要上传的文件");
      const extension = path.extname(request.file.originalname).toLowerCase();
      if (![".csv", ".gpx", ".tcx"].includes(extension)) {
        throw httpError(400, "UNSUPPORTED_FILE", "仅支持 CSV、GPX 和 TCX 文件");
      }

      const checksum = createHash("sha256")
        .update(request.file.buffer)
        .digest("hex");
      const importId = createImport({
        filename: request.file.originalname,
        format: extension.slice(1),
        fileSize: request.file.size,
        checksum
      });

      try {
        const parsed = parseImportFile(
          request.file.buffer,
          extension,
          request.file.originalname
        );
        if (!parsed.activities.length) {
          finishImport(importId, {
            status: "failed",
            imported: 0,
            skipped: 0,
            failed: parsed.errors.length,
            error: parsed.errors[0]?.message || "没有可导入的活动"
          });
          throw httpError(
            400,
            "NO_VALID_ACTIVITIES",
            parsed.errors[0]?.message || "没有可导入的活动"
          );
        }

        const result = saveActivities(parsed.activities, importId);
        if (result.inserted > 0) removeDemoActivities();
        const status =
          parsed.errors.length > 0
            ? "partial"
            : result.skipped > 0
              ? "completed_with_duplicates"
              : "completed";
        finishImport(importId, {
          status,
          imported: result.inserted,
          skipped: result.skipped,
          failed: parsed.errors.length
        });

        response.status(201).json({
          importId,
          imported: result.inserted,
          skipped: result.skipped,
          failed: parsed.errors.length,
          errors: parsed.errors.slice(0, 20),
          activities: parsed.activities.slice(0, 10)
        });
      } catch (error) {
        if (!error.code) {
          finishImport(importId, {
            status: "failed",
            imported: 0,
            skipped: 0,
            failed: 1,
            error: "文件解析失败"
          });
          throw httpError(
            400,
            "IMPORT_PARSE_FAILED",
            `文件解析失败：${error.message}`
          );
        }
        throw error;
      }
    })
  );

  app.delete("/api/imports/:id", (request, response) => {
    const result = deleteImport(request.params.id);
    if (!result) throw httpError(404, "IMPORT_NOT_FOUND", "导入记录不存在");
    response.json(result);
  });

  app.post("/api/demo/reset", (request, response) => {
    const result = resetDemoData();
    response.json({ ok: true, ...result });
  });
}
