import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";

import { errors, jwtVerify, SignJWT, type JWK } from "jose";
import { z } from "zod";

import { Duration } from "../../../shared/utils/duration.js";
import type { AuthConfig } from "../config/auth.config.js";
import { ACCESS_TOKEN_TYPE } from "../constants/auth.constants.js";
import { InvalidTokenError, TokenExpiredError } from "../errors/auth.errors.js";
import type { AccessClaims, IssuedToken } from "../types/auth.types.js";

const ALGORITHM = "RS256";

// What a valid access token must contain; anything else is rejected even if the signature is fine.
const accessPayload = z.object({
  typ: z.literal(ACCESS_TOKEN_TYPE),
  sub: z.string().min(1),
  sid: z.string().min(1),
  ndid: z.string().min(1),
  email: z.string().min(1),
  role: z.string().nullable(),
  admin: z.boolean(),
  perms: z.array(z.string()),
  props: z.array(z.object({ hid: z.string(), perms: z.array(z.string()) })),
  staff: z.boolean(),
  act: z.object({ sub: z.string().min(1), email: z.string().min(1) }).optional(),
});

export interface SignOptions {
  audience?: string;
  /** e.g. "1h" for switch-account tokens; default AUTH_ACCESS_TTL */
  ttl?: string;
}

/**
 * Signs and verifies our access tokens: RS256 JWTs. Only gian-new holds the private key.
 * Every other service (HMS, booking widgets) verifies with the public key published at
 * /.well-known/jwks.json, so a leak there can never be used to mint tokens.
 */
export class TokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly publicJwk: JWK;
  private readonly ttlSeconds: number;

  constructor(private readonly config: AuthConfig) {
    this.privateKey = createPrivateKey(config.AUTH_JWT_PRIVATE_KEY);
    this.publicKey = createPublicKey(this.privateKey);
    const { kty, n, e } = this.publicKey.export({ format: "jwk" });
    this.publicJwk = { kty, n, e, kid: config.AUTH_JWT_KEY_ID, alg: ALGORITHM, use: "sig" };
    this.ttlSeconds = Duration.toSeconds(config.AUTH_ACCESS_TTL);
  }

  async signAccessToken(claims: AccessClaims, options: SignOptions = {}): Promise<IssuedToken> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + (options.ttl ? Duration.toSeconds(options.ttl) : this.ttlSeconds);
    const { sub, ...rest } = claims;
    const token = await new SignJWT({ typ: ACCESS_TOKEN_TYPE, ...rest })
      .setProtectedHeader({ alg: ALGORITHM, kid: this.config.AUTH_JWT_KEY_ID, typ: "JWT" })
      .setSubject(sub)
      .setIssuer(this.config.AUTH_JWT_ISSUER)
      .setAudience(options.audience ?? this.config.AUTH_JWT_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(this.privateKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /** Checks signature, algorithm, issuer, audience, expiry and the claim shape. */
  async verifyAccessToken(token: string, audience = this.config.AUTH_JWT_AUDIENCE): Promise<AccessClaims> {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALGORITHM],
        issuer: this.config.AUTH_JWT_ISSUER,
        audience,
        clockTolerance: 5,
      }));
    } catch (error) {
      throw error instanceof errors.JWTExpired ? new TokenExpiredError() : new InvalidTokenError();
    }
    const parsed = accessPayload.safeParse(payload);
    if (!parsed.success) throw new InvalidTokenError();
    const { typ: _typ, ...claims } = parsed.data;
    return claims;
  }

  /** The public key set served at /.well-known/jwks.json. */
  jwks(): { keys: JWK[] } {
    return { keys: [this.publicJwk] };
  }
}
