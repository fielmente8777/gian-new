import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminAuditController } from "../controllers/admin-audit.controller.js";
import { AdminAuditQueryDto, auditPageSchema } from "../dtos/admin-audit.dto.js";
import type { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";

/** /api/v1/admin/audit-log, super admins only. Read-only: nothing can edit the log. */
export class AdminAuditRoutes extends BaseRoutes {
  constructor(c: AdminAuditController, auth: AdminAuthenticateMiddleware) {
    super("/admin/audit-log", { tag: "Admin audit log" });

    this.get(
      "/",
      {
        summary: "What staff did, newest first",
        query: AdminAuditQueryDto,
        response: { schema: auditPageSchema },
      },
      auth.require("audit.view"),
      c.list,
    );
  }
}
