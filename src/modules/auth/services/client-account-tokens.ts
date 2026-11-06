import { ServiceUnavailableError } from "../../../shared/errors/http-errors.js";
import type { LegacyTokenService } from "./legacy-token.service.js";

export interface ClientAccountToken {
  token: string;
  expiresAt: Date;
}

/**
 * The token a staff member gets to open a hotel's dashboard as that hotel. Only the admin
 * module calls this, after checking admin_users, the clients.open_account permission and
 * the person's assigned properties.
 *
 * It is a nexon-style token, because the hotel dashboard still calls nexon and gian, which
 * only understand those. It is short-lived (AUTH_IMPERSONATION_TTL) and has no refresh. Once
 * the dashboard runs on gian-new tokens, issue an access token with an `act` claim instead,
 * so every request names the staff member.
 */
export class ClientAccountTokens {
  constructor(
    private readonly legacyTokens: LegacyTokenService,
    private readonly ttlSeconds: number,
  ) {}

  async issue(accountEmail: string): Promise<ClientAccountToken> {
    if (!this.legacyTokens.enabled) {
      throw new ServiceUnavailableError("Opening client accounts needs AUTH_LEGACY_JWT_SECRET on the server", {
        code: "CLIENT_ACCOUNT_UNAVAILABLE",
      });
    }
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    return { token: await this.legacyTokens.sign(accountEmail, this.ttlSeconds), expiresAt };
  }
}
