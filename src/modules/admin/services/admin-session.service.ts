import { randomUUID } from "node:crypto";

import { InvalidRefreshTokenError, type ClientInfo, type RefreshTokenService, type Session } from "../../auth/index.js";
import { AdminNotAllowedError } from "../errors/admin.errors.js";
import type { AdminRecord, AdminUserStore } from "../types/admin.types.js";
import type { AdminTokenService } from "./admin-token.service.js";

/**
 * One admin login on one browser. Uses the same refresh-token rotation and theft detection
 * as hotel logins, kept apart by audience. Refreshing never asks for a new email code; the
 * code is asked for at each new login, once ADMIN_REFRESH_TTL_DAYS has passed or after signing out.
 */
export class AdminSessionService {
  constructor(
    private readonly tokens: AdminTokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly admins: Pick<AdminUserStore, "findById">,
  ) {}

  async start(admin: AdminRecord, client: ClientInfo): Promise<Session> {
    const sessionId = randomUUID();
    const refreshToken = await this.refreshTokens.issue(admin.id, sessionId, client);
    const accessToken = await this.tokens.sign({ sub: admin.id, sid: sessionId });
    return { sessionId, accessToken, refreshToken };
  }

  async refresh(token: string, client: ClientInfo): Promise<{ session: Session; admin: AdminRecord }> {
    const rotated = await this.refreshTokens.rotate(token, client);
    const admin = await this.admins.findById(rotated.userId);
    if (!admin || admin.status !== "active") {
      await this.refreshTokens.revokeFamily(rotated.familyId, "inactive");
      throw admin ? new AdminNotAllowedError() : new InvalidRefreshTokenError();
    }
    const accessToken = await this.tokens.sign({ sub: admin.id, sid: rotated.familyId });
    return {
      session: { sessionId: rotated.familyId, accessToken, refreshToken: rotated.refreshToken },
      admin,
    };
  }

  async end(token: string): Promise<void> {
    await this.refreshTokens.revoke(token, "logout");
  }
}
