import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { JwksController } from "../controllers/jwks.controller.js";
import { jwksSchema } from "../dtos/auth-response.dto.js";

/** /.well-known/jwks.json (root path, by convention) */
export class JwksRoutes extends BaseRoutes {
  constructor(c: JwksController) {
    super("/.well-known", { tag: "System" });
    this.get(
      "/jwks.json",
      {
        summary: "Public keys that verify our access tokens",
        description: "For other services (HMS, booking widgets): verify RS256 access tokens locally. Cached 5 minutes.",
        envelope: false,
        response: { schema: jwksSchema },
      },
      c.jwks,
    );
  }
}
