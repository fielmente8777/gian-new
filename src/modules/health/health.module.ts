import type { Router } from "express";

import type { Database } from "../../shared/database/database.js";
import type { AppModule } from "../../shared/module/app-module.js";
import { HealthController } from "./controllers/health.controller.js";
import { HealthRoutes } from "./routes/health.routes.js";

export class HealthModule implements AppModule {
  readonly name = "health";
  readonly rootRouter: Router;

  constructor(deps: { database: Database }) {
    this.rootRouter = new HealthRoutes(new HealthController(deps.database)).router;
  }
}
