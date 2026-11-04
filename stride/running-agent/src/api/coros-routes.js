import {
  corosStatus,
  disconnectCoros,
  finishCorosAuthorization,
  listCorosTools,
  startCorosAuthorization,
  syncCorosActivities
} from "../coros.js";
import {
  corosActivityCount,
  removeDemoActivities,
  saveActivities
} from "../db.js";

export function registerCorosRoutes(app, { asyncRoute }) {
  app.get("/api/coros/status", (request, response) => {
    response.json({
      ...corosStatus(),
      activityCount: corosActivityCount()
    });
  });

  app.get(
    "/api/auth/coros/start",
    asyncRoute(async (request, response) => {
      try {
        const region = String(request.query.region || "global");
        const result = await startCorosAuthorization(request, region);
        response.redirect(result.authorizeUrl);
      } catch (error) {
        response.redirect(
          `/?coros=error&reason=${encodeURIComponent(error.message)}`
        );
      }
    })
  );

  app.get(
    "/api/auth/coros/callback",
    asyncRoute(async (request, response) => {
      if (request.query.error) {
        const reason = String(
          request.query.error_description || request.query.error
        );
        return response.redirect(
          `/?coros=error&reason=${encodeURIComponent(reason)}`
        );
      }
      try {
        const result = await finishCorosAuthorization({
          code: String(request.query.code || ""),
          state: String(request.query.state || "")
        });
        response.redirect(
          `/?coros=connected&region=${encodeURIComponent(result.region)}`
        );
      } catch (error) {
        response.redirect(
          `/?coros=error&reason=${encodeURIComponent(error.message)}`
        );
      }
    })
  );

  app.get(
    "/api/coros/tools",
    asyncRoute(async (request, response) => {
      const tools = await listCorosTools();
      response.json({
        count: tools.length,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description || ""
        }))
      });
    })
  );

  app.post(
    "/api/coros/sync",
    asyncRoute(async (request, response) => {
      const days = Math.min(90, Math.max(1, Number(request.body.days || 30)));
      const result = await syncCorosActivities(days);
      if (!result.activities.length) {
        return response.json({
          imported: 0,
          skipped: 0,
          updated: 0,
          activities: [],
          message: result.ignoredCount
            ? "COROS 返回的记录中没有跑步活动"
            : "COROS 返回的记录中没有可识别的跑步数据"
        });
      }
      const saved = saveActivities(result.activities, null, {
        updateExisting: true
      });
      if (saved.inserted > 0) removeDemoActivities();
      response.json({
        imported: saved.inserted,
        skipped: saved.skipped,
        updated: saved.updated,
        fetched: result.recordCount,
        ignored: result.ignoredCount || 0,
        activities: result.activities
      });
    })
  );

  app.delete(
    "/api/coros/connection",
    asyncRoute(async (request, response) => {
      await disconnectCoros();
      response.json({ disconnected: true });
    })
  );
}
