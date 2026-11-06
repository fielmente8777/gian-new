import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";

import { errors, jwtVerify, SignJWT } from "jose";
import { z } from "zod";

import { Duration } from "../../../shared/utils/duration.js";
import { InvalidTokenError, TokenExpiredError, type AuthConfig, type IssuedToken } from "../../auth/index.js";
import type { AdminConfig } from "../config/admin.config.js";

const ALGORITHM = "RS256";
const ADMIN_TOKEN_TYPE = "admin_access";

// Only who and which session. Role and permissions are read from the database on every
// request, so taking away access works immediately instead of when the token expires.
const adminPayload = z.object({
  typ: z.literal(ADMIN_TOKEN_TYPE),
  sub: z.string().min(1),
  sid: z.string().min(1),
});

export interface AdminClaims {
  sub: string;
  sid: string;
}

/**
 * Access tokens for the admin console. Same signing key as hotel tokens, but a different
 * audience and type, so neither kind of token is ever accepted by the other API.
 */
export class AdminTokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly ttlSeconds: number;

  constructor(
    private readonly auth: AuthConfig,
    private readonly admin: AdminConfig,
  ) {
    this.privateKey = createPrivateKey(auth.AUTH_JWT_PRIVATE_KEY);
    this.publicKey = createPublicKey(this.privateKey);
    this.ttlSeconds = Duration.toSeconds(admin.ADMIN_ACCESS_TTL);
  }

  async sign({ sub, sid }: AdminClaims): Promise<IssuedToken> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.ttlSeconds;
    const token = await new SignJWT({ typ: ADMIN_TOKEN_TYPE, sid })
      .setProtectedHeader({ alg: ALGORITHM, kid: this.auth.AUTH_JWT_KEY_ID, typ: "JWT" })
      .setSubject(sub)
      .setIssuer(this.auth.AUTH_JWT_ISSUER)
      .setAudience(this.admin.ADMIN_JWT_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(this.privateKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async verify(token: string): Promise<AdminClaims> {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALGORITHM],
        issuer: this.auth.AUTH_JWT_ISSUER,
        audience: this.admin.ADMIN_JWT_AUDIENCE,
        clockTolerance: 5,
      }));
    } catch (error) {
      throw error instanceof errors.JWTExpired ? new TokenExpiredError() : new InvalidTokenError();
    }
    const parsed = adminPayload.safeParse(payload);
    if (!parsed.success) throw new InvalidTokenError();
    return { sub: parsed.data.sub, sid: parsed.data.sid };
  }
}
