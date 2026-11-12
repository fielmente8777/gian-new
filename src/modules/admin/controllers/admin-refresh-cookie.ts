import type { CookieOptions, Request, Response } from "express";

import { Cookies } from "../../../shared/http/cookies.js";
import type { AuthConfig, IssuedToken } from "../../auth/index.js";
import type { AdminConfig } from "../config/admin.config.js";

/** Only the admin login routes ever receive this cookie. */
const ADMIN_REFRESH_COOKIE_PATH = "/api/v1/admin/auth";

/** The admin refresh token: httpOnly, so page JavaScript can never read it. Separate from the hotel cookie. */
export class AdminRefreshCookie {
  private readonly name: string;
  private readonly options: CookieOptions;

  constructor(auth: AuthConfig, admin: AdminConfig) {
    this.name = admin.ADMIN_REFRESH_COOKIE_NAME;
    const crossSite = admin.ADMIN_COOKIE_SAMESITE === "none";
    this.options = {
      httpOnly: true,
      // browsers drop a SameSite=None cookie that is not Secure
      secure: crossSite || auth.AUTH_COOKIE_SECURE,
      sameSite: admin.ADMIN_COOKIE_SAMESITE,
      path: ADMIN_REFRESH_COOKIE_PATH,
      ...(auth.AUTH_COOKIE_DOMAIN ? { domain: auth.AUTH_COOKIE_DOMAIN } : {}),
    };
  }

  read(req: Request): string | undefined {
    return Cookies.get(req, this.name);
  }

  write(res: Response, token: IssuedToken): void {
    res.cookie(this.name, token.token, { ...this.options, expires: token.expiresAt });
  }

  clear(res: Response): void {
    res.clearCookie(this.name, this.options);
  }
}
