import type { Request, Response } from "express";

import type { Database } from "../../../shared/database/database.js";
import { BaseController } from "../../../shared/http/base-controller.js";

export class HealthController extends BaseController {
  constructor(private readonly database: Database) {
    super();
  }

  /** The process is up (Docker HEALTHCHECK). */
  live(_req: Request, res: Response): void {
    this.ok(res, { status: "ok" });
  }

  /** Dependencies answer (load balancer: send traffic only when ready). */
  async ready(_req: Request, res: Response): Promise<void> {
    const mongo = await this.database.isReady();
    res
      .status(mongo ? 200 : 503)
      .json({ success: mongo, data: { status: mongo ? "ok" : "unavailable", checks: { mongo } } });
  }
}
