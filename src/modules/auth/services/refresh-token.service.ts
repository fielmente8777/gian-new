import { createHash, randomBytes } from "node:crypto";

import { REFRESH_REUSE_GRACE_MS, REFRESH_TOKEN_BYTES } from "../constants/auth.constants.js";
import { InvalidRefreshTokenError, RefreshTokenReuseError } from "../errors/auth.errors.js";
import type { ClientInfo, IssuedToken, RefreshTokenStore, RevokeReason } from "../types/auth.types.js";

const DAY_MS = 86_400_000;

export interface RotatedRefreshToken {
  userId: string;
  familyId: string;
  staff: boolean;
  refreshToken: IssuedToken;
}

/**
 * Long-lived refresh tokens with rotation and reuse detection.
 *
 * - The token is 32 random bytes; only its SHA-256 is stored, so a DB leak gives no sessions.
 * - Every refresh replaces the token with a new one in the same family (one family = one login).
 * - Presenting an already-replaced token means it was copied: the whole family is revoked,
 *   which logs out both the thief and the user (who simply logs in again).
 */
export class RefreshTokenService {
  constructor(
    private readonly store: RefreshTokenStore,
    private readonly ttlDays: number,
    private readonly audience: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(userId: string, familyId: string, client: ClientInfo, staff = false): Promise<IssuedToken> {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + this.ttlDays * DAY_MS);
    await this.store.create({
      ...client,
      tokenHash: RefreshTokenService.hash(token),
      familyId,
      userId,
      audience: this.audience,
      staff,
      expiresAt,
    });
    return { token, expiresAt };
  }

  async rotate(token: string, client: ClientInfo): Promise<RotatedRefreshToken> {
    const tokenHash = RefreshTokenService.hash(token);
    const stored = await this.store.findByHash(tokenHash);
    if (!stored || stored.audience !== this.audience) throw new InvalidRefreshTokenError();

    const now = this.now();
    if (stored.revokedAt) {
      const parallelRefresh =
        stored.revokedReason === "rotated" && now.getTime() - stored.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS;
      if (parallelRefresh) throw new InvalidRefreshTokenError();
      if (stored.revokedReason === "rotated") {
        await this.store.revokeFamily(stored.familyId, "reuse");
        throw new RefreshTokenReuseError();
      }
      throw new InvalidRefreshTokenError();
    }
    if (stored.expiresAt.getTime() <= now.getTime()) throw new InvalidRefreshTokenError();

    const next = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const nextHash = RefreshTokenService.hash(next);
    // atomic: of two parallel refreshes only one wins, the other gets a 401
    if (!(await this.store.markRotated(tokenHash, nextHash))) throw new InvalidRefreshTokenError();

    const expiresAt = new Date(now.getTime() + this.ttlDays * DAY_MS);
    await this.store.create({
      ...client,
      tokenHash: nextHash,
      familyId: stored.familyId,
      userId: stored.userId,
      audience: this.audience,
      staff: stored.staff,
      expiresAt,
    });
    return {
      userId: stored.userId,
      familyId: stored.familyId,
      staff: stored.staff,
      refreshToken: { token: next, expiresAt },
    };
  }

  /** Ends the login this token belongs to. Unknown tokens are ignored (logout is idempotent). */
  async revoke(token: string, reason: RevokeReason): Promise<void> {
    const stored = await this.store.findByHash(RefreshTokenService.hash(token));
    if (stored) await this.store.revokeFamily(stored.familyId, reason);
  }

  async revokeFamily(familyId: string, reason: RevokeReason): Promise<void> {
    await this.store.revokeFamily(familyId, reason);
  }

  async revokeAllForUser(userId: string, reason: RevokeReason, exceptFamilyId?: string): Promise<void> {
    await this.store.revokeAllForUser(userId, reason, exceptFamilyId);
  }

  static hash(token: string): string {
    return createHash("sha256").update(token).digest("base64url");
  }
}
