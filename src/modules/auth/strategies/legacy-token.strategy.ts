import type { UsersPort } from "../../users/index.js";
import { AccountInactiveError, InvalidTokenError } from "../errors/auth.errors.js";
import type { LegacyTokenService } from "../services/legacy-token.service.js";
import type { StaffPolicy } from "../services/staff.policy.js";
import { AuthContext } from "../types/auth-context.js";
import type { TokenStrategy } from "./token.strategy.js";

/**
 * Old nexon tokens (HS256, `{ Email }`), verified locally with the shared secret, so the
 * current dashboard and Android app keep working without logging in again. The token only
 * holds an email, so the user is loaded on every request (what gian's authMiddleware does).
 *
 * Staff with an old token: the token cannot say how the user logged in, so staff = an email
 * on a staff domain whose account has been linked to Google (only a Google sign-in links it).
 * New tokens use the stricter rule (this very login was Google). Remove with the old clients.
 */
export class LegacyTokenStrategy implements TokenStrategy {
  readonly algorithm = "HS256";

  constructor(
    private readonly legacyTokens: LegacyTokenService,
    private readonly users: Pick<UsersPort, "findByEmail">,
    private readonly staffPolicy: StaffPolicy,
  ) {}

  async authenticate(token: string): Promise<AuthContext> {
    const { email } = await this.legacyTokens.verify(token);
    const user = await this.users.findByEmail(email);
    if (!user) throw new InvalidTokenError();
    if (!user.isActive) throw new AccountInactiveError();
    const staff = user.googleId !== null && this.staffPolicy.isStaffEmail(user.email);
    return AuthContext.fromUser(user, "legacy", null, { staff });
  }
}
