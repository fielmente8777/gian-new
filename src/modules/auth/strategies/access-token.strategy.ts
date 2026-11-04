import type { TokenService } from "../services/token.service.js";
import { AuthContext } from "../types/auth-context.js";
import type { TokenStrategy } from "./token.strategy.js";

/** Our own RS256 access tokens. No database call: everything needed is in the signed claims. */
export class AccessTokenStrategy implements TokenStrategy {
  readonly algorithm = "RS256";

  constructor(private readonly tokens: TokenService) {}

  async authenticate(token: string): Promise<AuthContext> {
    return AuthContext.fromClaims(await this.tokens.verifyAccessToken(token));
  }
}
