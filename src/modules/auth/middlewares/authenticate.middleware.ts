import type { Request, RequestHandler } from "express";
import { decodeProtectedHeader } from "jose";

import { RouteDocs } from "../../../shared/docs/route-doc.js";
import { InvalidTokenError, MissingTokenError, PermissionDeniedError } from "../errors/auth.errors.js";
import type { TokenStrategy } from "../strategies/token.strategy.js";
import type { AuthContext } from "../types/auth-context.js";
import "../types/auth.types.js";

export interface RequireOptions {
  /** Property the permission is checked on, e.g. `(req) => req.params.hid`. */
  hid?: (req: Request) => string | undefined;
}

/**
 * Protects routes. Other modules get it from AuthModule and use it on every non-public route:
 *
 *   router.get("/", auth.require(), c.list)                                     // any signed-in user
 *   router.put("/:hid/rooms", auth.require("bookingEngine", { hid: (r) => r.params.hid }), c.update)
 */
export class AuthenticateMiddleware {
  constructor(private readonly strategies: readonly TokenStrategy[]) {}

  require(permission?: string, options: RequireOptions = {}): RequestHandler {
    const handler: RequestHandler = async (req, _res, next) => {
      const context = await this.authenticate(req);
      if (permission && !context.can(permission, options.hid?.(req))) throw new PermissionDeniedError(permission);
      req.auth = context;
      next();
    };
    // every route using it is documented as "needs a Bearer token" (+ the permission)
    return RouteDocs.describe(handler, {
      bearer: true,
      permission,
      errors: {
        401: "TOKEN_MISSING, TOKEN_INVALID, TOKEN_EXPIRED",
        403: permission ? "PERMISSION_DENIED, ACCOUNT_INACTIVE" : "ACCOUNT_INACTIVE",
      },
    });
  }

  /** Verifies the Bearer token with the strategy for its algorithm. */
  async authenticate(req: Request): Promise<AuthContext> {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get("authorization") ?? "");
    const token = match?.[1];
    if (!token) throw new MissingTokenError();

    let algorithm: string | undefined;
    try {
      algorithm = decodeProtectedHeader(token).alg;
    } catch {
      throw new InvalidTokenError();
    }
    const strategy = this.strategies.find((s) => s.algorithm === algorithm);
    if (!strategy) throw new InvalidTokenError();
    return strategy.authenticate(token);
  }
}
