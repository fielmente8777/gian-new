import type { CookieOptions, Request, Response } from "express";

import { Cookies } from "../../../shared/http/cookies.js";
import type { AuthConfig } from "../config/auth.config.js";
import { REFRESH_COOKIE_PATH } from "../constants/auth.constants.js";
import type { IssuedToken } from "../types/auth.types.js";

/**
 * The refresh token lives only in this cookie: httpOnly (page JavaScript cannot read it,
 * so XSS cannot steal it), Secure, SameSite=Lax (other sites cannot send it), and scoped
 * to /api/v1/auth (the rest of the API never sees it).
 */
export class RefreshCookie {
  private readonly options: CookieOptions;

  constructor(private readonly config: AuthConfig) {
    this.options = {
      httpOnly: true,
      secure: config.AUTH_COOKIE_SECURE,
      sameSite: "lax",
      path: REFRESH_COOKIE_PATH,
      ...(config.AUTH_COOKIE_DOMAIN ? { domain: config.AUTH_COOKIE_DOMAIN } : {}),
    };
  }

  read(req: Request): string | undefined {
    return Cookies.get(req, this.config.AUTH_REFRESH_COOKIE_NAME);
  }

  write(res: Response, token: IssuedToken): void {
    res.cookie(this.config.AUTH_REFRESH_COOKIE_NAME, token.token, { ...this.options, expires: token.expiresAt });
  }

  clear(res: Response): void {
    res.clearCookie(this.config.AUTH_REFRESH_COOKIE_NAME, this.options);
  }
}
