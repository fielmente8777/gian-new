import type { RequestHandler } from "express";

import type { HeaderDoc } from "../../../shared/docs/route-doc.js";
import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AuthController } from "../controllers/auth.controller.js";
import { meResponseSchema, sessionResponseSchema } from "../dtos/auth-response.dto.js";
import { ChangePasswordDto } from "../dtos/change-password.dto.js";
import { GoogleLoginDto } from "../dtos/google-login.dto.js";
import { LoginDto } from "../dtos/login.dto.js";
import { RefreshDto } from "../dtos/refresh.dto.js";
import { RegisterDto } from "../dtos/register.dto.js";
import type { AuthenticateMiddleware } from "../middlewares/authenticate.middleware.js";

const CLIENT_HEADERS: HeaderDoc[] = [
  {
    name: "X-Client-Platform",
    description: "`android` / `ios` from the mobile app: the refresh token comes in the body instead of a cookie",
    enum: ["web", "android", "ios"],
  },
  { name: "X-Device-Id", description: "stable id of the phone, stored with the session" },
];

const SESSION = { schema: sessionResponseSchema, description: "Signed in. Web: refresh token set as httpOnly cookie" };

/** /api/v1/auth/* (dashboard and mobile app) */
export class AuthRoutes extends BaseRoutes {
  constructor(c: AuthController, auth: AuthenticateMiddleware, loginLimit: RequestHandler) {
    super("/auth", { tag: "Auth" });

    this.post(
      "/login",
      {
        summary: "Log in with email and password",
        body: LoginDto,
        headers: CLIENT_HEADERS,
        response: SESSION,
        errors: { 401: "INVALID_CREDENTIALS", 403: "ACCOUNT_INACTIVE" },
      },
      loginLimit,
      c.login,
    );
    this.post(
      "/register",
      {
        summary: "Create a new hotel account (owner)",
        description: "Creates the owner user with full access and a new tenant (ndid), then signs in.",
        body: RegisterDto,
        headers: CLIENT_HEADERS,
        response: { ...SESSION, status: 201 },
        errors: { 409: "EMAIL_TAKEN" },
      },
      loginLimit,
      c.register,
    );
    this.post(
      "/google",
      {
        summary: "Sign in with Google",
        description:
          "Send the Google ID token (web button `credential`, or Android Credential Manager with `serverClientId` = web client id). " +
          "An unknown email creates a new owner account (201). A verified @eazotel.com / @fielmente.com email signs in as staff.",
        body: GoogleLoginDto,
        headers: CLIENT_HEADERS,
        response: SESSION,
        errors: { 401: "GOOGLE_TOKEN_INVALID", 403: "ACCOUNT_INACTIVE", 503: "GOOGLE_LOGIN_DISABLED" },
      },
      loginLimit,
      c.loginWithGoogle,
    );
    this.post(
      "/refresh",
      {
        summary: "Get a new access token",
        description:
          "Web: send nothing, the cookie is used and rotated. Mobile: send `{ refreshToken }`, get the new one in the body.",
        body: RefreshDto,
        refreshCookie: true,
        headers: CLIENT_HEADERS,
        response: { schema: sessionResponseSchema },
        errors: { 401: "REFRESH_TOKEN_INVALID, REFRESH_TOKEN_REUSED (session revoked)" },
      },
      c.refresh,
    );
    this.post(
      "/logout",
      { summary: "Log out this device", body: RefreshDto, refreshCookie: true, response: { status: 204 } },
      c.logout,
    );

    this.get("/me", { summary: "The signed-in user", response: { schema: meResponseSchema } }, auth.require(), c.me);
    this.post(
      "/password",
      {
        summary: "Change password",
        description: "Other devices are logged out; this one stays signed in.",
        body: ChangePasswordDto,
        response: { status: 204 },
        errors: { 401: "CURRENT_PASSWORD_INVALID" },
      },
      auth.require(),
      c.changePassword,
    );
    this.post(
      "/legacy/exchange",
      {
        summary: "Swap an old nexon token for a new session",
        description:
          "Call with the old token as Bearer. Lets the current dashboard and app move to the new tokens without a new login.",
        headers: CLIENT_HEADERS,
        response: SESSION,
        errors: { 400: "NOT_A_LEGACY_TOKEN" },
      },
      auth.require(),
      c.exchangeLegacyToken,
    );
  }
}
