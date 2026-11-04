import { z } from "zod";

import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { HealthController } from "../controllers/health.controller.js";

const liveSchema = z.object({ status: z.literal("ok") });
const readySchema = z.object({ status: z.enum(["ok", "unavailable"]), checks: z.object({ mongo: z.boolean() }) });

/** /health/live and /health/ready, at the root for Docker and load balancers. */
export class HealthRoutes extends BaseRoutes {
  constructor(c: HealthController) {
    super("/health", { tag: "System" });
    this.get("/live", { summary: "Process is up (Docker HEALTHCHECK)", response: { schema: liveSchema } }, c.live);
    this.get(
      "/ready",
      {
        summary: "Dependencies answer (load balancer)",
        response: { schema: readySchema },
        errors: { 503: "MongoDB not reachable" },
      },
      c.ready,
    );
  }
}
