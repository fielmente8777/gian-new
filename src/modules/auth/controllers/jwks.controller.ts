import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import type { TokenService } from "../services/token.service.js";

/** Public keys other services use to verify our access tokens. Standard JWKS format, no envelope. */
export class JwksController extends BaseController {
  constructor(private readonly tokens: TokenService) {
    super();
  }

  jwks(_req: Request, res: Response): void {
    res.set("Cache-Control", "public, max-age=300").json(this.tokens.jwks());
  }
}
