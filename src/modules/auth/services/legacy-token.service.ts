import { errors, jwtVerify, SignJWT } from "jose";

import type { AuthConfig } from "../config/auth.config.js";
import { InvalidTokenError, TokenExpiredError } from "../errors/auth.errors.js";

const ALGORITHM = "HS256";
const DAY_SECONDS = 86_400;

/**
 * nexon-compatible tokens: HS256 with the secret nexon and gian share, payload
 * `{ Email, exp }` (nexon utils.create). Exists only for the migration:
 * - verify: users logged in through nexon are accepted by gian-new without a new login;
 * - sign: the old login paths gian-new serves (/eazotel/ceateuser…) return tokens that
 *   nexon and gian still accept.
 * Delete this class when nexon is retired.
 */
export class LegacyTokenService {
  private readonly secret: Uint8Array | null;
  private readonly ttlSeconds: number;

  constructor(config: AuthConfig) {
    this.secret = config.AUTH_LEGACY_JWT_SECRET ? new TextEncoder().encode(config.AUTH_LEGACY_JWT_SECRET) : null;
    this.ttlSeconds = config.AUTH_LEGACY_TOKEN_TTL_DAYS * DAY_SECONDS;
  }

  get enabled(): boolean {
    return this.secret !== null;
  }

  /** `ttlSeconds` shortens the token, e.g. for a staff member switching into a client account. */
  async sign(email: string, ttlSeconds = this.ttlSeconds): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return new SignJWT({ Email: email })
      .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
      .setExpirationTime(exp)
      .sign(this.requireSecret());
  }

  /** Returns the email of a valid nexon dashboard token. Guest ({ Number }) and admin ({ emailId }) tokens are rejected. */
  async verify(token: string): Promise<{ email: string }> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.requireSecret(), { algorithms: [ALGORITHM], clockTolerance: 5 }));
    } catch (error) {
      throw error instanceof errors.JWTExpired ? new TokenExpiredError() : new InvalidTokenError();
    }
    // nexon never enforced exp itself (it relied on PyJWT), but every token it issues has one
    if (typeof payload.exp !== "number") throw new InvalidTokenError();
    const email = payload.Email;
    if (typeof email !== "string" || email.trim() === "") throw new InvalidTokenError();
    return { email };
  }

  private requireSecret(): Uint8Array {
    if (!this.secret) throw new InvalidTokenError();
    return this.secret;
  }
}
