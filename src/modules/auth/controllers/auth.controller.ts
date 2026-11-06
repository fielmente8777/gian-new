import type { Request, Response } from "express";

import { BadRequestError } from "../../../shared/errors/http-errors.js";
import { BaseController } from "../../../shared/http/base-controller.js";
import { RequestClient } from "../../../shared/http/request-client.js";
import type { UserRecord } from "../../users/index.js";
import { AuthUserDto, SessionResponseDto, type SessionResponse } from "../dtos/auth-response.dto.js";
import type { ChangePasswordBody } from "../dtos/change-password.dto.js";
import type { GoogleLoginBody } from "../dtos/google-login.dto.js";
import type { LoginInput } from "../dtos/login.dto.js";
import type { RefreshBody } from "../dtos/refresh.dto.js";
import type { RegisterBody } from "../dtos/register.dto.js";
import { InvalidRefreshTokenError } from "../errors/auth.errors.js";
import type { AuthService } from "../services/auth.service.js";
import type { SessionService } from "../services/session.service.js";
import { AuthContext } from "../types/auth-context.js";
import type { RefreshCookie } from "./refresh-cookie.js";

/**
 * /api/v1/auth/*, for the dashboard (browser) and the mobile app.
 * The refresh token travels in an httpOnly cookie for browsers, and in the JSON body for
 * native apps (`X-Client-Platform: android | ios`). It always goes back the way it came.
 * Bodies are already validated by the route's DTO when a method runs.
 */
export class AuthController extends BaseController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly cookie: RefreshCookie,
  ) {
    super();
  }

  async login(req: Request, res: Response): Promise<void> {
    const { user, staff } = await this.auth.loginWithPassword(req.body as LoginInput, RequestClient.of(req));
    this.ok(res, await this.startSession(req, res, user, staff));
  }

  async register(req: Request, res: Response): Promise<void> {
    const user = await this.auth.register(req.body as RegisterBody);
    this.created(res, await this.startSession(req, res, user, false));
  }

  async loginWithGoogle(req: Request, res: Response): Promise<void> {
    const { user, created, staff } = await this.auth.loginWithGoogle(
      req.body as GoogleLoginBody,
      RequestClient.of(req),
    );
    const body = await this.startSession(req, res, user, staff);
    if (created) this.created(res, body);
    else this.ok(res, body);
  }

  /** New access token + rotated refresh token. A failed refresh also clears the cookie. */
  async refresh(req: Request, res: Response): Promise<void> {
    const { token, fromBody } = this.readRefreshToken(req);
    if (!token) throw new InvalidRefreshTokenError();
    try {
      const { session, user, staff } = await this.sessions.refresh(token, RequestClient.of(req));
      if (!fromBody) this.cookie.write(res, session.refreshToken);
      this.ok(res, SessionResponseDto.from(session, user, { includeRefreshToken: fromBody, isStaff: staff }));
    } catch (error) {
      if (!fromBody) this.cookie.clear(res);
      throw error;
    }
  }

  async logout(req: Request, res: Response): Promise<void> {
    const { token, fromBody } = this.readRefreshToken(req);
    if (token) await this.sessions.end(token);
    if (!fromBody) this.cookie.clear(res);
    this.noContent(res);
  }

  async me(req: Request, res: Response): Promise<void> {
    const context = AuthContext.of(req);
    const user = await this.auth.getUser(context.userId);
    this.ok(res, AuthUserDto.me(user, context));
  }

  /** Other devices are logged out; this one stays logged in. */
  async changePassword(req: Request, res: Response): Promise<void> {
    const context = AuthContext.of(req);
    const { currentPassword, newPassword } = req.body as ChangePasswordBody;
    await this.auth.changePassword(context.userId, currentPassword, newPassword, context.sessionId);
    this.noContent(res);
  }

  /** Turns an old nexon token into a new session, so a logged-in user moves over without typing a password. */
  async exchangeLegacyToken(req: Request, res: Response): Promise<void> {
    const context = AuthContext.of(req);
    if (context.source !== "legacy") {
      throw new BadRequestError("Only an old nexon token can be exchanged", { code: "NOT_A_LEGACY_TOKEN" });
    }
    const user = await this.auth.getUser(context.userId);
    this.ok(res, await this.startSession(req, res, user, false));
  }

  private async startSession(req: Request, res: Response, user: UserRecord, staff: boolean): Promise<SessionResponse> {
    const client = RequestClient.of(req);
    const session = await this.sessions.start(user, client, { staff });
    const native = RequestClient.isNative(client.platform);
    if (!native) this.cookie.write(res, session.refreshToken);
    return SessionResponseDto.from(session, user, { includeRefreshToken: native, isStaff: staff });
  }

  private readRefreshToken(req: Request): { token: string | undefined; fromBody: boolean } {
    const fromBody = (req.body as RefreshBody | undefined)?.refreshToken;
    return fromBody ? { token: fromBody, fromBody: true } : { token: this.cookie.read(req), fromBody: false };
  }
}
