import type { Router } from "express";

import { GoogleIdTokenVerifier } from "../../integrations/google/google-id-token.verifier.js";
import type { EventBus } from "../../shared/events/event-bus.js";
import type { Logger } from "../../shared/logger/logger.js";
import { RateLimiter } from "../../shared/middlewares/rate-limit.middleware.js";
import type { AppModule } from "../../shared/module/app-module.js";
import { Duration } from "../../shared/utils/duration.js";
import type { UsersPort } from "../users/index.js";
import type { AuthConfig } from "./config/auth.config.js";
import { LOGIN_ATTEMPT_WINDOW_MS } from "./constants/auth.constants.js";
import { AuthController } from "./controllers/auth.controller.js";
import { AuthLegacyController } from "./controllers/auth.legacy.controller.js";
import { JwksController } from "./controllers/jwks.controller.js";
import { RefreshCookie } from "./controllers/refresh-cookie.js";
import { AuthLegacyMapper } from "./mappers/auth.legacy.mapper.js";
import { AuthenticateMiddleware } from "./middlewares/authenticate.middleware.js";
import { CredentialRepository } from "./repositories/credential.repository.js";
import { RefreshTokenRepository } from "./repositories/refresh-token.repository.js";
import { AuthLegacyRoutes } from "./routes/auth.legacy.routes.js";
import { AuthRoutes } from "./routes/auth.routes.js";
import { JwksRoutes } from "./routes/jwks.routes.js";
import { AuthService } from "./services/auth.service.js";
import { CredentialService } from "./services/credential.service.js";
import { LegacyTokenService } from "./services/legacy-token.service.js";
import { PasswordService } from "./services/password.service.js";
import { RefreshTokenService } from "./services/refresh-token.service.js";
import { SessionService } from "./services/session.service.js";
import { StaffPolicy } from "./services/staff.policy.js";
import { TokenService } from "./services/token.service.js";
import { AccessTokenStrategy } from "./strategies/access-token.strategy.js";
import { GoogleStrategy } from "./strategies/google.strategy.js";
import { LegacyTokenStrategy } from "./strategies/legacy-token.strategy.js";
import { PasswordStrategy } from "./strategies/password.strategy.js";
import type { TokenStrategy } from "./strategies/token.strategy.js";
import type { CredentialStore, GoogleIdentityVerifier, RefreshTokenStore } from "./types/auth.types.js";

export interface AuthModuleDeps {
  config: AuthConfig;
  logger: Logger;
  events: EventBus;
  users: UsersPort;
  /** Tests replace the Mongo stores and Google with fakes. */
  overrides?: {
    credentials?: CredentialStore;
    refreshTokens?: RefreshTokenStore;
    google?: GoogleIdentityVerifier | null;
  };
}

/**
 * Builds every class of the auth module (its own small container) and exposes:
 * - `authenticate`: the middleware other modules protect their routes with;
 * - `tokens`: to verify access tokens elsewhere (e.g. websockets);
 * - the routers: /api/v1/auth/*, /.well-known/jwks.json and the old nexon login paths.
 */
export class AuthModule implements AppModule {
  readonly name = "auth";
  readonly router: Router;
  readonly rootRouter: Router;
  readonly legacyRouter?: Router;
  readonly authenticate: AuthenticateMiddleware;
  readonly tokens: TokenService;

  private readonly stores: { credentials: CredentialStore; refreshTokens: RefreshTokenStore };

  constructor(private readonly deps: AuthModuleDeps) {
    const { config, logger, events, users, overrides = {} } = deps;

    // storage
    this.stores = {
      credentials: overrides.credentials ?? new CredentialRepository(),
      refreshTokens: overrides.refreshTokens ?? new RefreshTokenRepository(),
    };
    const google =
      overrides.google !== undefined
        ? overrides.google
        : config.AUTH_GOOGLE_CLIENT_IDS.length > 0
          ? new GoogleIdTokenVerifier(config.AUTH_GOOGLE_CLIENT_IDS)
          : null;
    if (!google) logger.warn("AUTH_GOOGLE_CLIENT_IDS is empty: Google sign-in (and so staff login) is off");

    // services
    this.tokens = new TokenService(config);
    const legacyTokens = new LegacyTokenService(config);
    const staffPolicy = new StaffPolicy(config.AUTH_STAFF_EMAIL_DOMAINS);
    const passwords = new PasswordService(config.AUTH_BCRYPT_ROUNDS);
    const credentials = new CredentialService(
      this.stores.credentials,
      users,
      passwords,
      config.AUTH_LEGACY_PASSWORD_SYNC,
    );
    const refreshTokens = new RefreshTokenService(
      this.stores.refreshTokens,
      config.AUTH_REFRESH_TTL_DAYS,
      config.AUTH_JWT_AUDIENCE,
    );
    const sessions = new SessionService(this.tokens, refreshTokens, users, staffPolicy, config.AUTH_IMPERSONATION_TTL);
    const auth = new AuthService(
      users,
      new PasswordStrategy(users, credentials, passwords),
      new GoogleStrategy(users, google, staffPolicy),
      credentials,
      sessions,
      events,
    );

    // request authentication: our tokens always, old nexon tokens while the secret is set
    const strategies: TokenStrategy[] = [new AccessTokenStrategy(this.tokens)];
    if (legacyTokens.enabled) strategies.push(new LegacyTokenStrategy(legacyTokens, users, staffPolicy));
    this.authenticate = new AuthenticateMiddleware(strategies);

    // audit trail: who opened which client account (to a collection once the audit module exists)
    events.on("user.account_switched", (event) => {
      logger.info({ audit: "account_switched", ...event }, "staff switched into a client account");
    });

    // HTTP
    const loginLimit = (onLimit?: Parameters<typeof RateLimiter.create>[0]["onLimit"]) =>
      RateLimiter.create({
        windowMs: LOGIN_ATTEMPT_WINDOW_MS,
        limit: config.AUTH_LOGIN_MAX_ATTEMPTS,
        skipSuccessfulRequests: true,
        key: (req) =>
          String(req.body?.email ?? req.body?.emailId ?? "")
            .trim()
            .toLowerCase(),
        onLimit,
      });

    this.router = new AuthRoutes(
      new AuthController(auth, sessions, new RefreshCookie(config)),
      this.authenticate,
      loginLimit(),
    ).router;
    this.rootRouter = new JwksRoutes(new JwksController(this.tokens)).router;

    if (legacyTokens.enabled) {
      const legacyLimit = loginLimit((_req, res) => {
        res.status(429).json({ ...AuthLegacyMapper.failure(), Message: "Too many attempts, try again in 15 minutes" });
      });
      const legacyController = new AuthLegacyController(
        auth,
        legacyTokens,
        users,
        logger,
        Duration.toSeconds(config.AUTH_IMPERSONATION_TTL),
      );
      this.legacyRouter = new AuthLegacyRoutes(legacyController, this.authenticate, legacyLimit).router;
    } else {
      logger.warn(
        "AUTH_LEGACY_JWT_SECRET is not set: old nexon tokens are rejected and the legacy login paths are off",
      );
    }
  }

  /** Builds the indexes of the module's own collections (new, small: safe to run on every start). */
  async init(): Promise<void> {
    const { credentials, refreshTokens } = this.stores;
    if (credentials instanceof CredentialRepository) await credentials.ensureIndexes();
    if (refreshTokens instanceof RefreshTokenRepository) await refreshTokens.ensureIndexes();
    this.deps.logger.debug("auth indexes ready");
  }
}
