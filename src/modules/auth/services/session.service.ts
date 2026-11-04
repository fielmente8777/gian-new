import { randomUUID } from "node:crypto";

import type { UserRecord, UsersPort } from "../../users/index.js";
import { AccountInactiveError, InvalidRefreshTokenError } from "../errors/auth.errors.js";
import { AuthContext } from "../types/auth-context.js";
import type { Actor, ClientInfo, IssuedToken, Session } from "../types/auth.types.js";
import type { RefreshTokenService } from "./refresh-token.service.js";
import type { StaffPolicy } from "./staff.policy.js";
import type { TokenService } from "./token.service.js";

/**
 * A session = one login on one device (browser or phone): a refresh-token family plus
 * short access tokens. Access-token claims are rebuilt from the user on every refresh, so
 * permission changes and deactivation take effect within one access-token lifetime.
 */
export class SessionService {
  constructor(
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly users: Pick<UsersPort, "findById">,
    private readonly staffPolicy: StaffPolicy,
    private readonly switchTtl: string,
  ) {}

  async start(user: UserRecord, client: ClientInfo, { staff = false } = {}): Promise<Session> {
    const sessionId = randomUUID();
    const context = AuthContext.fromUser(user, "access", sessionId, { staff });
    const refreshToken = await this.refreshTokens.issue(user.id, sessionId, client, context.isStaff);
    const accessToken = await this.tokens.signAccessToken(context.toClaims(sessionId));
    return { sessionId, accessToken, refreshToken };
  }

  async refresh(token: string, client: ClientInfo): Promise<{ session: Session; user: UserRecord; staff: boolean }> {
    const rotated = await this.refreshTokens.rotate(token, client);
    const user = await this.users.findById(rotated.userId);
    if (!user || !user.isActive) {
      await this.refreshTokens.revokeFamily(rotated.familyId, "inactive");
      throw user ? new AccountInactiveError() : new InvalidRefreshTokenError();
    }
    // removing a domain from AUTH_STAFF_EMAIL_DOMAINS ends staff rights at the next refresh
    const staff = rotated.staff && this.staffPolicy.isStaffEmail(user.email);
    const context = AuthContext.fromUser(user, "access", rotated.familyId, { staff });
    const accessToken = await this.tokens.signAccessToken(context.toClaims(rotated.familyId));
    return {
      session: { sessionId: rotated.familyId, accessToken, refreshToken: rotated.refreshToken },
      user,
      staff: context.isStaff,
    };
  }

  /**
   * Access token for a staff member working inside a client account. It names the staff
   * member (`act`), expires after AUTH_IMPERSONATION_TTL, has no refresh token and cannot
   * switch again. The staff member's own session is untouched.
   */
  async switchInto(target: UserRecord, actor: Actor): Promise<IssuedToken> {
    const sessionId = `switch:${randomUUID()}`;
    const context = AuthContext.fromUser(target, "access", null, { actor });
    return this.tokens.signAccessToken(context.toClaims(sessionId), { ttl: this.switchTtl });
  }

  async end(token: string): Promise<void> {
    await this.refreshTokens.revoke(token, "logout");
  }

  /** Logs the user out everywhere except the given session (after a password change). */
  async endOthers(userId: string, keepSessionId: string | null): Promise<void> {
    await this.refreshTokens.revokeAllForUser(userId, "password_changed", keepSessionId ?? undefined);
  }
}
