import type { RequestHandler } from "express";

import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminAuthController } from "../controllers/admin-auth.controller.js";
import {
  adminProfileSchema,
  adminSessionSchema,
  AdminGoogleLoginDto,
  AdminResendOtpDto,
  AdminVerifyOtpDto,
  pendingLoginSchema,
} from "../dtos/admin-auth.dto.js";
import type { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";

/** /api/v1/admin/auth/* (admin console) */
export class AdminAuthRoutes extends BaseRoutes {
  constructor(c: AdminAuthController, auth: AdminAuthenticateMiddleware, loginLimit: RequestHandler) {
    super("/admin/auth", { tag: "Admin auth" });

    this.post(
      "/google",
      {
        summary: "Step 1: sign in with Google",
        description:
          "The email must already be in admin_users; nothing is ever created for an unknown one. " +
          "Emails a 6-digit code and returns a `challengeId`. No session exists until step 2.",
        body: AdminGoogleLoginDto,
        response: { schema: pendingLoginSchema },
        errors: {
          401: "GOOGLE_TOKEN_INVALID",
          403: "ADMIN_NOT_ALLOWED",
          503: "GOOGLE_LOGIN_DISABLED, OTP_SEND_FAILED",
        },
      },
      loginLimit,
      c.loginWithGoogle,
    );
    this.post(
      "/otp/verify",
      {
        summary: "Step 2: enter the emailed code",
        description: "Starts the session: returns the access token and sets the httpOnly refresh cookie.",
        body: AdminVerifyOtpDto,
        response: { schema: adminSessionSchema },
        errors: {
          400: "OTP_EXPIRED",
          401: "OTP_INVALID",
          403: "ADMIN_NOT_ALLOWED",
          429: "OTP_ATTEMPTS_EXCEEDED",
        },
      },
      loginLimit,
      c.verifyOtp,
    );
    this.post(
      "/otp/resend",
      {
        summary: "Email a new code",
        description: "The old code stops working. Wrong attempts already made still count.",
        body: AdminResendOtpDto,
        response: { schema: pendingLoginSchema },
        errors: {
          400: "OTP_EXPIRED",
          403: "ADMIN_NOT_ALLOWED",
          429: "OTP_RESEND_UNAVAILABLE",
          503: "OTP_SEND_FAILED",
        },
      },
      loginLimit,
      c.resendOtp,
    );
    this.post(
      "/refresh",
      {
        summary: "Get a new access token",
        description: "Uses and rotates the admin refresh cookie. No new code is needed.",
        response: { schema: adminSessionSchema },
        errors: { 401: "REFRESH_TOKEN_INVALID, REFRESH_TOKEN_REUSED", 403: "ADMIN_NOT_ALLOWED" },
      },
      c.refresh,
    );
    this.post("/logout", { summary: "Sign out of this browser", response: { status: 204 } }, c.logout);
    this.get(
      "/me",
      { summary: "The signed-in staff member", response: { schema: adminProfileSchema } },
      auth.require(),
      c.me,
    );
  }
}
