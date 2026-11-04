// Public API of the auth module. Other modules import from here only (README §3.4).
export { AuthModule, type AuthModuleDeps } from "./auth.module.js";
export { AuthenticateMiddleware, type RequireOptions } from "./middlewares/authenticate.middleware.js";
export { AuthContext } from "./types/auth-context.js";
export type { AccessClaims, PropertyAccess, TokenSource } from "./types/auth.types.js";
export { authConfig, type AuthConfig } from "./config/auth.config.js";
