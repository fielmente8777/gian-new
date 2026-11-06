// Public API of the auth module. Other modules import from here only (README §3.4).
export { AuthModule, type AuthModuleDeps } from "./auth.module.js";
export { AuthenticateMiddleware, type RequireOptions } from "./middlewares/authenticate.middleware.js";
export { AuthContext } from "./types/auth-context.js";
export type {
  AccessClaims,
  ClientInfo,
  GoogleIdentity,
  GoogleIdentityVerifier,
  IssuedToken,
  PropertyAccess,
  RefreshTokenStore,
  Session,
  TokenSource,
} from "./types/auth.types.js";
export { authConfig, type AuthConfig } from "./config/auth.config.js";
// The admin module reuses refresh-token rotation and the token errors, with its own audience.
export { RefreshTokenService } from "./services/refresh-token.service.js";
export { ClientAccountTokens, type ClientAccountToken } from "./services/client-account-tokens.js";
export { RefreshTokenRepository } from "./repositories/refresh-token.repository.js";
export {
  GoogleLoginDisabledError,
  InvalidGoogleTokenError,
  InvalidRefreshTokenError,
  InvalidTokenError,
  MissingTokenError,
  TokenExpiredError,
} from "./errors/auth.errors.js";
