import {
  normalizeModelConfig,
  testModelConnection,
  validateModelConfig
} from "../model-gateway.js";

export function registerModelRoutes(app, { asyncRoute }) {
  app.post(
    "/api/model/test",
    asyncRoute(async (request, response) => {
      const config = normalizeModelConfig(request.body);
      validateModelConfig(config);
      const result = await testModelConnection(config);
      response.json(result);
    })
  );
}
