import type { Router } from "express";

import { GoogleIdTokenVerifier } from "../../integrations/google/google-id-token.verifier.js";
import type { Mailer } from "../../integrations/mail/mailer.js";
import type { EventBus } from "../../shared/events/event-bus.js";
import type { Logger } from "../../shared/logger/logger.js";
import { RateLimiter } from "../../shared/middlewares/rate-limit.middleware.js";
import type { AppModule } from "../../shared/module/app-module.js";
import {
  RefreshTokenRepository,
  RefreshTokenService,
  type AuthConfig,
  type GoogleIdentityVerifier,
  type RefreshTokenStore,
} from "../auth/index.js";
import type { BillingPort } from "../billing/index.js";
import type { ClientArchivePort } from "../client-archive/index.js";
import type { HotelNotificationsPort } from "../hotel-notifications/index.js";
import type { SubscriptionsPort } from "../subscriptions/index.js";
import type { ProfilesPort } from "../profiles/index.js";
import type { UsersPort } from "../users/index.js";
import type { AdminConfig } from "./config/admin.config.js";
import { AdminAuditController } from "./controllers/admin-audit.controller.js";
import { AdminBillingController } from "./controllers/admin-billing.controller.js";
import { AdminAuthController } from "./controllers/admin-auth.controller.js";
import { AdminClientsController } from "./controllers/admin-clients.controller.js";
import { AdminSubscriptionsController } from "./controllers/admin-subscriptions.controller.js";
import { AdminRefreshCookie } from "./controllers/admin-refresh-cookie.js";
import { AdminTeamController } from "./controllers/admin-team.controller.js";
import { AdminAuthenticateMiddleware } from "./middlewares/admin-authenticate.middleware.js";
import { AdminAuditLogRepository } from "./repositories/admin-audit-log.repository.js";
import { AdminLoginChallengeRepository } from "./repositories/admin-login-challenge.repository.js";
import { AdminUserRepository } from "./repositories/admin-user.repository.js";
import { AdminAuditRoutes } from "./routes/admin-audit.routes.js";
import { AdminBillingRoutes } from "./routes/admin-billing.routes.js";
import { AdminAuthRoutes } from "./routes/admin-auth.routes.js";
import { AdminClientsRoutes } from "./routes/admin-clients.routes.js";
import { AdminSubscriptionsRoutes } from "./routes/admin-subscriptions.routes.js";
import { AdminTeamRoutes } from "./routes/admin-team.routes.js";
import { AdminRoutes } from "./routes/admin.routes.js";
import { AdminAuditService } from "./services/admin-audit.service.js";
import { AdminAuthService } from "./services/admin-auth.service.js";
import { AdminBillingService } from "./services/admin-billing.service.js";
import {
  AdminClientsService,
  type ClientAccountIssuer,
  type ServiceControl,
} from "./services/admin-clients.service.js";
import { AdminSubscriptionsService } from "./services/admin-subscriptions.service.js";
import { AdminOtpService } from "./services/admin-otp.service.js";
import { AdminSessionService } from "./services/admin-session.service.js";
import { AdminTeamService } from "./services/admin-team.service.js";
import { AdminTokenService } from "./services/admin-token.service.js";
import type { AdminAuditStore, AdminUserStore, OtpChallengeStore } from "./types/admin.types.js";

const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60_000;

export interface AdminModuleDeps {
  config: AdminConfig;
  authConfig: AuthConfig;
  logger: Logger;
  events: EventBus;
  mailer: Mailer;
  /** hotel client profiles and accounts, owned by other modules */
  profiles: ProfilesPort;
  users: Pick<UsersPort, "findOwnerByNdid">;
  /** signs the hotel-dashboard token when staff open a client account (auth module) */
  clientAccounts: ClientAccountIssuer;
  /** the switches and the enforcer (client-services module) */
  serviceControl: ServiceControl;
  subscriptions: SubscriptionsPort;
  /** deletes a client, archiving every record first (client-archive module) */
  clientArchive: ClientArchivePort;
  /** each property's own lead alerts (hotel-notifications module) */
  hotelNotifications: HotelNotificationsPort;
  /** plans, prices, offers and payments (billing module) */
  billing: BillingPort;
  /** Tests replace the Mongo stores and Google with fakes. */
  overrides?: {
    admins?: AdminUserStore;
    challenges?: OtpChallengeStore;
    auditLog?: AdminAuditStore;
    refreshTokens?: RefreshTokenStore;
    google?: GoogleIdentityVerifier | null;
  };
}

/**
 * The Eazotel staff console's backend. Staff live in admin_users, never in Zucks_users, and
 * get their own token audience and refresh cookie. See the README in this folder.
 */
export class AdminModule implements AppModule {
  readonly name = "admin";
  readonly router: Router;
  readonly authenticate: AdminAuthenticateMiddleware;

  private readonly stores: { admins: AdminUserStore; challenges: OtpChallengeStore; auditLog: AdminAuditStore };

  constructor(deps: AdminModuleDeps) {
    const {
      config,
      authConfig,
      logger,
      events,
      mailer,
      profiles,
      users,
      clientAccounts,
      serviceControl,
      subscriptions,
      clientArchive,
      hotelNotifications,
      billing,
      overrides = {},
    } = deps;

    this.stores = {
      admins: overrides.admins ?? new AdminUserRepository(),
      challenges: overrides.challenges ?? new AdminLoginChallengeRepository(),
      auditLog: overrides.auditLog ?? new AdminAuditLogRepository(),
    };
    const google =
      overrides.google !== undefined
        ? overrides.google
        : authConfig.AUTH_GOOGLE_CLIENT_IDS.length > 0
          ? new GoogleIdTokenVerifier(authConfig.AUTH_GOOGLE_CLIENT_IDS)
          : null;

    const tokens = new AdminTokenService(authConfig, config);
    // same rotation and theft detection as hotel logins; the audience keeps the two apart
    const refreshTokens = new RefreshTokenService(
      overrides.refreshTokens ?? new RefreshTokenRepository(),
      config.ADMIN_REFRESH_TTL_DAYS,
      config.ADMIN_JWT_AUDIENCE,
    );
    const sessions = new AdminSessionService(tokens, refreshTokens, this.stores.admins);
    const otp = new AdminOtpService(this.stores.challenges, mailer, config);
    const auth = new AdminAuthService(this.stores.admins, google, otp, events);
    this.authenticate = new AdminAuthenticateMiddleware(tokens, this.stores.admins);

    const audit = new AdminAuditService(this.stores.auditLog, logger);
    const team = new AdminTeamService(this.stores.admins, audit, refreshTokens);

    events.on("admin.login_denied", ({ email, reason, ip }) =>
      audit.record({ action: "login.denied", actorEmail: email, details: { reason }, ip }),
    );
    events.on("admin.login_code_sent", ({ adminId, email, ip }) =>
      audit.record({ action: "login.code_sent", actorId: adminId, actorEmail: email, ip }),
    );
    events.on("admin.logged_in", ({ adminId, email, ip }) =>
      audit.record({ action: "login.success", actorId: adminId, actorEmail: email, ip }),
    );

    const loginLimit = RateLimiter.create({
      windowMs: LOGIN_ATTEMPT_WINDOW_MS,
      limit: authConfig.AUTH_LOGIN_MAX_ATTEMPTS,
      skipSuccessfulRequests: true,
    });
    this.router = new AdminRoutes(
      new AdminAuthRoutes(
        new AdminAuthController(auth, sessions, new AdminRefreshCookie(authConfig, config)),
        this.authenticate,
        loginLimit,
      ),
      new AdminTeamRoutes(new AdminTeamController(team), this.authenticate),
      new AdminClientsRoutes(
        new AdminClientsController(
          new AdminClientsService(
            profiles,
            users,
            audit,
            clientAccounts,
            serviceControl,
            clientArchive,
            hotelNotifications,
          ),
        ),
        this.authenticate,
      ),
      new AdminSubscriptionsRoutes(
        new AdminSubscriptionsController(new AdminSubscriptionsService(subscriptions, serviceControl, audit)),
        this.authenticate,
      ),
      new AdminBillingRoutes(new AdminBillingController(new AdminBillingService(billing, audit)), this.authenticate),
      new AdminAuditRoutes(new AdminAuditController(audit), this.authenticate),
    ).router;
  }

  async init(): Promise<void> {
    const { admins, challenges, auditLog } = this.stores;
    if (admins instanceof AdminUserRepository) await admins.ensureIndexes();
    if (challenges instanceof AdminLoginChallengeRepository) await challenges.ensureIndexes();
    if (auditLog instanceof AdminAuditLogRepository) await auditLog.ensureIndexes();
  }
}
