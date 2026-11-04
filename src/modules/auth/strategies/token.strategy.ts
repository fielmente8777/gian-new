import type { AuthContext } from "../types/auth-context.js";

/**
 * One kind of bearer token the API accepts. AuthenticateMiddleware picks the strategy by
 * the token's `alg` header, so supporting a new token is a new class, not an `if`.
 */
export interface TokenStrategy {
  /** JWT `alg` this strategy handles, e.g. "RS256". */
  readonly algorithm: string;
  authenticate(token: string): Promise<AuthContext>;
}
