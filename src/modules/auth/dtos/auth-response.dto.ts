import { z } from "zod";

import type { UserRecord } from "../../users/index.js";
import type { AuthContext } from "../types/auth-context.js";
import type { IssuedToken, Session } from "../types/auth.types.js";

// Response shapes of /api/v1/auth. The zod schemas document the API (/docs); the types the
// code builds are inferred from them, so docs and code cannot disagree.

export const authUserSchema = z.object({
  id: z.string().meta({ example: "65f0c2a1e4b0a1b2c3d4e5f6" }),
  ndid: z.string().nullable().meta({ description: "tenant (hotel group) id", example: "3f1c9b2e-…" }),
  email: z.string().meta({ example: "owner@hotel.com" }),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  role: z.string().nullable().meta({ example: "superadmin" }),
  isAdmin: z.boolean().meta({ description: "account admin: manages the team, sees every property" }),
  scopes: z.array(z.string()).meta({ description: "account-level feature access", example: ["bookingEngine", "cms"] }),
  locations: z
    .array(z.object({ hid: z.string(), scopes: z.array(z.string()) }))
    .meta({ description: "properties a team member is assigned to, with their feature access" }),
  onboarding: z.boolean().meta({ description: "onboarding finished" }),
});

const tokenFields = {
  accessToken: z.string().meta({ description: "send as `Authorization: Bearer <accessToken>`" }),
  tokenType: z.literal("Bearer"),
  expiresAt: z.iso.datetime().meta({ description: "access token expiry; refresh shortly before" }),
};

export const sessionResponseSchema = z.object({
  ...tokenFields,
  isStaff: z.boolean().meta({ description: "Eazotel / Fielmente team: may list clients and switch accounts" }),
  user: authUserSchema,
  refreshToken: z.string().optional().meta({
    description:
      "**mobile app only** (`X-Client-Platform: android|ios`). Browsers get it as an httpOnly cookie instead",
  }),
  refreshTokenExpiresAt: z.iso.datetime().optional().meta({ description: "mobile app only" }),
});

export const switchResponseSchema = z.object({
  ...tokenFields,
  user: authUserSchema,
  switchedBy: z.object({ email: z.string() }),
});

export const meResponseSchema = authUserSchema.extend({
  isStaff: z.boolean(),
  switchedBy: z
    .object({ email: z.string() })
    .nullable()
    .meta({ description: "set while a staff member works inside this account" }),
});

export const jwksSchema = z.object({
  keys: z.array(
    z.object({ kty: z.string(), kid: z.string(), alg: z.string(), use: z.string(), n: z.string(), e: z.string() }),
  ),
});

export type AuthUserResponse = z.infer<typeof authUserSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type SwitchResponse = z.infer<typeof switchResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;

export class AuthUserDto {
  static from(user: UserRecord): AuthUserResponse {
    return {
      id: user.id,
      ndid: user.ndid,
      email: user.email,
      name: user.displayName ?? user.userName,
      phone: user.phone,
      role: user.role,
      isAdmin: user.isAdmin,
      scopes: user.scopes,
      locations: user.locations.map((l) => ({ hid: l.hid, scopes: l.scopes })),
      onboarding: user.onboarding,
    };
  }

  static me(user: UserRecord, context: AuthContext): MeResponse {
    return {
      ...AuthUserDto.from(user),
      isStaff: context.isStaff,
      switchedBy: context.actor ? { email: context.actor.email } : null,
    };
  }
}

export class SessionResponseDto {
  /**
   * Browsers get the refresh token only as an httpOnly cookie (page scripts cannot read it).
   * Native apps have no cookie jar for that, so they get it in the body (`includeRefreshToken`).
   */
  static from(
    session: Session,
    user: UserRecord,
    { includeRefreshToken = false, isStaff = false } = {},
  ): SessionResponse {
    return {
      accessToken: session.accessToken.token,
      tokenType: "Bearer",
      expiresAt: session.accessToken.expiresAt.toISOString(),
      isStaff,
      user: AuthUserDto.from(user),
      ...(includeRefreshToken
        ? {
            refreshToken: session.refreshToken.token,
            refreshTokenExpiresAt: session.refreshToken.expiresAt.toISOString(),
          }
        : {}),
    };
  }

  static switched(token: IssuedToken, user: UserRecord, actorEmail: string): SwitchResponse {
    return {
      accessToken: token.token,
      tokenType: "Bearer",
      expiresAt: token.expiresAt.toISOString(),
      user: AuthUserDto.from(user),
      switchedBy: { email: actorEmail },
    };
  }
}
