import type { Request, Response } from "express";
import { z } from "zod";

import { NotFoundError } from "../../../shared/errors/http-errors.js";
import { BaseController } from "../../../shared/http/base-controller.js";
import { RequestClient } from "../../../shared/http/request-client.js";
import type { Logger } from "../../../shared/logger/logger.js";
import type { UsersPort } from "../../users/index.js";
import { LegacyCreateUserDto, LegacyEditPasswordDto, type LegacyCreateUserBody } from "../dtos/legacy.dtos.js";
import {
  AccountInactiveError,
  EmailTakenError,
  GoogleLoginDisabledError,
  InvalidCredentialsError,
  InvalidGoogleTokenError,
  InvalidTokenError,
  StaffOnlyError,
  TokenExpiredError,
} from "../errors/auth.errors.js";
import { AuthLegacyMapper } from "../mappers/auth.legacy.mapper.js";
import type { AuthService } from "../services/auth.service.js";
import type { LegacyTokenService } from "../services/legacy-token.service.js";
import { AuthContext } from "../types/auth-context.js";

const switchBody = z.object({ Email: z.string().trim().min(3).max(254) });

/**
 * Old nexon paths, answered by gian-new in nexon's exact shapes (README §9), so the current
 * dashboard, onboarding app and Android app work unchanged once nginx sends a path here.
 * Like nexon, outcomes are HTTP 200 with `Status`, except /user/googleauth errors (500).
 * Errors never use the /api/v1 envelope here: each method catches and maps them itself.
 */
export class AuthLegacyController extends BaseController {
  constructor(
    private readonly auth: AuthService,
    private readonly legacyTokens: LegacyTokenService,
    private readonly users: Pick<UsersPort, "findByEmail">,
    private readonly logger: Logger,
    private readonly switchTtlSeconds: number,
  ) {
    super();
  }

  /** POST /eazotel/ceateuser */
  async createUser(req: Request, res: Response): Promise<void> {
    const parsed = LegacyCreateUserDto.parse(req.body);
    if (!parsed.success) {
      res.locals.rateLimitFailure = true;
      res.json(AuthLegacyMapper.failure());
      return;
    }
    if (parsed.data.register === "true") return this.register(parsed.data, res);

    try {
      const { user } = await this.auth.loginWithPassword(
        { email: parsed.data.emailId, password: parsed.data.accesskey },
        RequestClient.of(req),
      );
      // signed with the stored email, so an exact emailId lookup always finds the user
      res.json(AuthLegacyMapper.loginOk(await this.legacyTokens.sign(user.email)));
    } catch (error) {
      res.locals.rateLimitFailure = true;
      res.json(this.isLoginRejection(error) ? AuthLegacyMapper.loginFailed() : this.unexpected(error, req));
    }
  }

  /** POST /user/googleauth  (Authorization: Bearer <Google ID token>) */
  async googleAuth(req: Request, res: Response): Promise<void> {
    const idToken = /^Bearer\s+(\S+)/i.exec(req.get("authorization") ?? "")?.[1];
    if (!idToken) {
      res.status(500).json(AuthLegacyMapper.googleError("Missing google token"));
      return;
    }
    try {
      const { user, created } = await this.auth.loginWithGoogle({ idToken }, RequestClient.of(req));
      res.json(AuthLegacyMapper.googleOk(await this.legacyTokens.sign(user.email), created, user.onboarding));
    } catch (error) {
      if (error instanceof AccountInactiveError) {
        res.json(AuthLegacyMapper.googleInactive());
      } else if (error instanceof InvalidGoogleTokenError || error instanceof GoogleLoginDisabledError) {
        res.status(500).json(AuthLegacyMapper.googleError(error.message));
      } else {
        this.unexpected(error, req);
        res.status(500).json(AuthLegacyMapper.googleError("Internal Server Error"));
      }
    }
  }

  /** POST /eazotel/edit/password  { token, oldAccessId, newAccessId } */
  async editPassword(req: Request, res: Response): Promise<void> {
    const parsed = LegacyEditPasswordDto.parse(req.body);
    if (!parsed.success) {
      res.json(AuthLegacyMapper.failure());
      return;
    }
    try {
      const { email } = await this.legacyTokens.verify(parsed.data.token);
      const user = await this.users.findByEmail(email);
      if (!user) {
        res.json(AuthLegacyMapper.failure());
        return;
      }
      await this.auth.changePassword(user.id, parsed.data.oldAccessId, parsed.data.newAccessId, null);
      res.json(AuthLegacyMapper.passwordChanged());
    } catch (error) {
      res.locals.rateLimitFailure = true;
      if (error instanceof InvalidCredentialsError) res.json(AuthLegacyMapper.passwordNotChanged());
      else if (error instanceof InvalidTokenError || error instanceof TokenExpiredError)
        res.json(AuthLegacyMapper.failure());
      else res.json(this.unexpected(error, req));
    }
  }

  /**
   * POST /admin/switch-account  { Email }  (route requires a signed-in user)
   * nexon signs any body for anyone. Here only staff may switch, the target must exist,
   * the token lasts AUTH_IMPERSONATION_TTL instead of 15 days, and every switch is audited.
   */
  async switchAccount(req: Request, res: Response): Promise<void> {
    const parsed = switchBody.safeParse(req.body);
    if (!parsed.success) {
      res.json(AuthLegacyMapper.failure());
      return;
    }
    try {
      const target = await this.auth.switchAccount(AuthContext.of(req), { email: parsed.data.Email });
      res.json(AuthLegacyMapper.switched(await this.legacyTokens.sign(target.email, this.switchTtlSeconds)));
    } catch (error) {
      if (error instanceof StaffOnlyError)
        res.status(403).json({ ...AuthLegacyMapper.failure(), Message: error.message });
      else if (error instanceof NotFoundError || error instanceof AccountInactiveError)
        res.json(AuthLegacyMapper.failure());
      else res.json(this.unexpected(error, req));
    }
  }

  private async register(body: LegacyCreateUserBody, res: Response): Promise<void> {
    try {
      const user = await this.auth.register({
        email: body.emailId,
        password: body.accesskey,
        name: body.userName ?? "",
        phone: body.hotelPhone === null || body.hotelPhone === undefined ? undefined : String(body.hotelPhone),
      });
      res.json(AuthLegacyMapper.registered(await this.legacyTokens.sign(user.email)));
    } catch (error) {
      if (error instanceof EmailTakenError) res.json(AuthLegacyMapper.alreadyRegistered());
      else res.json(this.unexpected(error, res.req));
    }
  }

  private isLoginRejection(error: unknown): boolean {
    return error instanceof InvalidCredentialsError || error instanceof AccountInactiveError;
  }

  private unexpected(error: unknown, req: Request) {
    this.logger.error({ err: error, requestId: req.requestId }, `legacy ${req.method} ${req.path} failed`);
    return AuthLegacyMapper.failure();
  }
}
