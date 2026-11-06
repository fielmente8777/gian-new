import type { RequestHandler } from "express";
import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AuthLegacyController } from "../controllers/auth.legacy.controller.js";
import { LegacyCreateUserDto, LegacyEditPasswordDto } from "../dtos/legacy.dtos.js";
import { legacyGoogleSchema, legacyStatusSchema } from "../mappers/auth.legacy.mapper.js";
import type { AuthenticateMiddleware } from "../middlewares/authenticate.middleware.js";

class LegacySwitchDto extends BaseDto {
  static override readonly schema = z.object({ Email: z.string().meta({ description: "client owner's email" }) });
}

// docs only (validate: false): bad input gets nexon's `{ Status: false }`, not our 400 envelope
const LEGACY = { tags: ["Legacy (nexon)"], envelope: false, validate: false, deprecated: true } as const;

/**
 * Old nexon paths (typos included), exactly as clients call them today. They only get
 * traffic once nginx sends that path here (README §9.2); until then nexon answers them.
 */
export class AuthLegacyRoutes extends BaseRoutes {
  constructor(c: AuthLegacyController, auth: AuthenticateMiddleware, loginLimit: RequestHandler) {
    super("/");
    this.post(
      "/eazotel/ceateuser",
      {
        ...LEGACY,
        summary: 'nexon login, or sign-up when register = "true"',
        description: "Use `POST /api/v1/auth/login` / `register` in new code. Always HTTP 200; check `Status`.",
        body: LegacyCreateUserDto,
        response: { schema: legacyStatusSchema },
      },
      loginLimit,
      c.createUser,
    );
    this.post(
      "/user/googleauth",
      {
        ...LEGACY,
        summary: "nexon Google sign-in (Authorization: Bearer <Google ID token>)",
        description: "Use `POST /api/v1/auth/google` in new code.",
        response: { schema: legacyGoogleSchema },
        errors: { 500: "invalid or missing Google token: `{ Message, Status: false }`" },
      },
      loginLimit,
      c.googleAuth,
    );
    this.post(
      "/eazotel/edit/password",
      {
        ...LEGACY,
        summary: "nexon change password (token in the body)",
        description: "Use `POST /api/v1/auth/password` in new code.",
        body: LegacyEditPasswordDto,
        response: { schema: legacyStatusSchema },
      },
      loginLimit,
      c.editPassword,
    );
    this.post(
      "/admin/switch-account",
      {
        ...LEGACY,
        summary: "Retired: always 403. Staff open client accounts from the admin console",
        description:
          "nexon signed a token for anyone who asked. Use `POST /api/v1/admin/clients/{ndid}/open-account` with an admin token.",
        body: LegacySwitchDto,
        response: { schema: legacyStatusSchema },
        errors: { 403: "always: `{ Status: false, Message }`" },
      },
      c.switchAccount,
    );
  }
}
