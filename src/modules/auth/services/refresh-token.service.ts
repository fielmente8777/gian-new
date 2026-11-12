import { createHash, randomBytes } from "node:crypto";

import { REFRESH_REUSE_GRACE_MS, REFRESH_TOKEN_BYTES } from "../constants/auth.constants.js";
import { InvalidRefreshTokenError, RefreshInProgressError, RefreshTokenReuseError } from "../errors/auth.errors.js";
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
 * - A replaced token whose replacement was never used is a lost response, not a theft: the
 *   browser sent the refresh, then the page reloaded or closed (or two tabs refreshed at once)
 *   before the new cookie was stored. The unused replacement is retired and the login carries
 *   on, so a reload never signs anyone out.
 * - A replaced token whose replacement WAS used means two holders: the whole family is
 *   revoked, which logs out both the thief and the user (who simply logs in again).
 * - Each refresh moves the expiry forward (sliding): a login lasts until it sits unused for
 *   the whole TTL, or until logout.
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
    // the token to replace: this one, or the unused replacement of a response that got lost
    let current = stored;
    if (stored.revokedAt) {
      if (stored.revokedReason !== "rotated") throw new InvalidRefreshTokenError();
      const successor = stored.replacedByHash ? await this.store.findByHash(stored.replacedByHash) : null;
      const unused = successor && !successor.revokedAt && successor.expiresAt.getTime() > now.getTime();
      if (unused) {
        current = successor;
      } else if (now.getTime() - stored.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS) {
        // a parallel refresh is replacing the replacement right now: try again shortly
        throw new RefreshInProgressError();
      } else {
        await this.store.revokeFamily(stored.familyId, "reuse");
        throw new RefreshTokenReuseError();
      }
    }
    if (current.expiresAt.getTime() <= now.getTime()) throw new InvalidRefreshTokenError();

    const next = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const nextHash = RefreshTokenService.hash(next);
    // atomic: of two parallel refreshes only one replaces a token; the other is told to retry,
    // and its retry continues from the winner's (still unused) replacement
    if (!(await this.store.markRotated(current.tokenHash, nextHash))) throw new RefreshInProgressError();

    const expiresAt = new Date(now.getTime() + this.ttlDays * DAY_MS);
    await this.store.create({
      ...client,
      tokenHash: nextHash,
      familyId: current.familyId,
      userId: current.userId,
      audience: this.audience,
      staff: current.staff,
      expiresAt,
    });
    return {
      userId: current.userId,
      familyId: current.familyId,
      staff: current.staff,
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
