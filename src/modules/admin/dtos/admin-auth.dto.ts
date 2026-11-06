import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import type { Session } from "../../auth/index.js";
import { AdminPermissions } from "../services/admin-permissions.service.js";
import type { PendingLogin } from "../services/admin-auth.service.js";
import type { AdminRecord } from "../types/admin.types.js";

export class AdminGoogleLoginDto extends BaseDto {
  static override readonly schema = z.object({
    /** the `credential` the Google sign-in button returns */
    idToken: z.string().min(20, "idToken is required").max(4096),
  });
}
export type AdminGoogleLoginBody = z.infer<typeof AdminGoogleLoginDto.schema>;

const challengeId = z.uuid("Invalid sign-in attempt");

export class AdminVerifyOtpDto extends BaseDto {
  static override readonly schema = z.object({
    challengeId,
    code: z
      .string()
      .regex(/^\d{6}$/, "Enter the 6-digit code")
      .meta({ example: "482913" }),
  });
}
export type AdminVerifyOtpBody = z.infer<typeof AdminVerifyOtpDto.schema>;

export class AdminResendOtpDto extends BaseDto {
  static override readonly schema = z.object({ challengeId });
}
export type AdminResendOtpBody = z.infer<typeof AdminResendOtpDto.schema>;

// ── responses ───────────────────────────────────────────────────────────────

export const pendingLoginSchema = z.object({
  challengeId: z.string().meta({ description: "send this back with the emailed code" }),
  email: z.string().meta({ description: "where the code went, partly hidden", example: "sa***@eazotel.com" }),
  expiresAt: z.iso.datetime(),
  resendAfterSeconds: z.number().meta({ description: "wait this long before asking for a new code", example: 60 }),
});

export const adminProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.enum(["super_admin", "admin"]),
  permissions: z.array(z.string()).meta({ example: ["clients.view", "credits.view"] }),
  allProperties: z.boolean().meta({ description: "super admin: sees every property" }),
  assignedProperties: z.array(z.object({ ndid: z.string(), hid: z.string() })),
});

export const adminSessionSchema = z.object({
  accessToken: z.string().meta({ description: "send as `Authorization: Bearer <accessToken>`" }),
  tokenType: z.literal("Bearer"),
  expiresAt: z.iso.datetime(),
  admin: adminProfileSchema,
});

export type AdminProfile = z.infer<typeof adminProfileSchema>;
export type AdminSessionResponse = z.infer<typeof adminSessionSchema>;

export class AdminResponseDto {
  static pending({ id, email, expiresAt, resendAfterSeconds }: PendingLogin): z.infer<typeof pendingLoginSchema> {
    return { challengeId: id, email, expiresAt: expiresAt.toISOString(), resendAfterSeconds };
  }

  static profile(admin: AdminRecord): AdminProfile {
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      permissions: AdminPermissions.effective(admin),
      allProperties: AdminPermissions.isSuperAdmin(admin),
      assignedProperties: admin.assignedProperties,
    };
  }

  static session(session: Session, admin: AdminRecord): AdminSessionResponse {
    return {
      accessToken: session.accessToken.token,
      tokenType: "Bearer",
      expiresAt: session.accessToken.expiresAt.toISOString(),
      admin: AdminResponseDto.profile(admin),
    };
  }
}
