import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import { RequestClient } from "../../../shared/http/request-client.js";
import { InvalidRefreshTokenError, RefreshInProgressError } from "../../auth/index.js";
import {
  AdminResponseDto,
  type AdminGoogleLoginBody,
  type AdminResendOtpBody,
  type AdminVerifyOtpBody,
} from "../dtos/admin-auth.dto.js";
import { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";
import type { AdminAuthService } from "../services/admin-auth.service.js";
import type { AdminSessionService } from "../services/admin-session.service.js";
import type { AdminRefreshCookie } from "./admin-refresh-cookie.js";

/** /api/v1/admin/auth/*, used by the admin console only. */
export class AdminAuthController extends BaseController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly sessions: AdminSessionService,
    private readonly cookie: AdminRefreshCookie,
  ) {
    super();
  }

  /** Step 1: Google is verified and the code is emailed. No session exists yet. */
  async loginWithGoogle(req: Request, res: Response): Promise<void> {
    const { idToken } = req.body as AdminGoogleLoginBody;
    this.ok(res, AdminResponseDto.pending(await this.auth.startLogin(idToken, RequestClient.of(req))));
  }

  /** Step 2: the right code starts the session. */
  async verifyOtp(req: Request, res: Response): Promise<void> {
    const { challengeId, code } = req.body as AdminVerifyOtpBody;
    const client = RequestClient.of(req);
    const admin = await this.auth.completeLogin(challengeId, code, client);
    const session = await this.sessions.start(admin, client);
    this.cookie.write(res, session.refreshToken);
    this.ok(res, AdminResponseDto.session(session, admin));
  }

  async resendOtp(req: Request, res: Response): Promise<void> {
    const { challengeId } = req.body as AdminResendOtpBody;
    this.ok(res, AdminResponseDto.pending(await this.auth.resendCode(challengeId)));
  }

  /** New access token + rotated refresh cookie. A failed refresh also clears the cookie. */
  async refresh(req: Request, res: Response): Promise<void> {
    const token = this.cookie.read(req);
    if (!token) throw new InvalidRefreshTokenError();
    try {
      const { session, admin } = await this.sessions.refresh(token, RequestClient.of(req));
      this.cookie.write(res, session.refreshToken);
      this.ok(res, AdminResponseDto.session(session, admin));
    } catch (error) {
      // a refresh racing another keeps its cookie: the session is fine, the client retries
      if (!(error instanceof RefreshInProgressError)) this.cookie.clear(res);
      throw error;
    }
  }

  async logout(req: Request, res: Response): Promise<void> {
    const token = this.cookie.read(req);
    if (token) await this.sessions.end(token);
    this.cookie.clear(res);
    this.noContent(res);
  }

  async me(req: Request, res: Response): Promise<void> {
    this.ok(res, AdminResponseDto.profile(AdminAuthenticateMiddleware.of(req)));
  }
}
