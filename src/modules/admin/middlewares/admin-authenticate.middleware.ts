import type { Request, RequestHandler } from "express";

import { RouteDocs } from "../../../shared/docs/route-doc.js";
import { UnauthorizedError } from "../../../shared/errors/http-errors.js";
import { MissingTokenError } from "../../auth/index.js";
import type { AdminPermission } from "../constants/admin-permissions.js";
import { AdminNotAllowedError, AdminPermissionDeniedError } from "../errors/admin.errors.js";
import { AdminPermissions } from "../services/admin-permissions.service.js";
import type { AdminTokenService } from "../services/admin-token.service.js";
import type { AdminRecord, AdminUserStore } from "../types/admin.types.js";
import "../types/admin.types.js";

/**
 * Protects admin routes:
 *
 *   this.get("/clients", spec, auth.require("clients.view"), c.list)
 *
 * The staff member is read from the database on every request, so disabling someone or
 * taking away a permission applies to their very next click.
 */
export class AdminAuthenticateMiddleware {
  constructor(
    private readonly tokens: AdminTokenService,
    private readonly admins: Pick<AdminUserStore, "findById">,
  ) {}

  require(permission?: AdminPermission): RequestHandler {
    const handler: RequestHandler = async (req, _res, next) => {
      const admin = await this.authenticate(req);
      if (permission && !AdminPermissions.has(admin, permission)) throw new AdminPermissionDeniedError(permission);
      req.admin = admin;
      next();
    };
    return RouteDocs.describe(handler, {
      bearer: true,
      permission,
      errors: {
        401: "TOKEN_MISSING, TOKEN_INVALID, TOKEN_EXPIRED",
        403: permission ? "PERMISSION_DENIED, ADMIN_NOT_ALLOWED" : "ADMIN_NOT_ALLOWED",
      },
    });
  }

  /** The signed-in staff member. Throws 401 on a route that forgot `require`. */
  static of(req: Request): AdminRecord {
    if (!req.admin) throw new UnauthorizedError();
    return req.admin;
  }

  private async authenticate(req: Request): Promise<AdminRecord> {
    const token = /^Bearer\s+(\S+)\s*$/i.exec(req.get("authorization") ?? "")?.[1];
    if (!token) throw new MissingTokenError();
    const { sub } = await this.tokens.verify(token);
    const admin = await this.admins.findById(sub);
    if (!admin || admin.status !== "active") throw new AdminNotAllowedError();
    return admin;
  }
}
