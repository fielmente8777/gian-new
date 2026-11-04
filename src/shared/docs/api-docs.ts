import { Router } from "express";
import swaggerUi from "swagger-ui-express";

/**
 * Serves the generated OpenAPI document:
 * - GET /docs               Swagger UI: browse and try every endpoint (Authorize → paste an accessToken)
 * - GET /docs/openapi.json  the raw spec, for Postman import or client generation
 *                           (e.g. openapi-generator → Kotlin client for the Android app)
 */
export class ApiDocs {
  static router(spec: Record<string, unknown>): Router {
    const router = Router();
    router.get("/docs/openapi.json", (_req, res) => {
      res.json(spec);
    });
    router.use(
      "/docs",
      swaggerUi.serve,
      swaggerUi.setup(spec, {
        customSiteTitle: "Eazotel API",
        swaggerOptions: {
          persistAuthorization: true,
          displayRequestDuration: true,
          docExpansion: "list",
          filter: true,
          tryItOutEnabled: true,
          withCredentials: true,
        },
      }),
    );
    return router;
  }
}
