import { createPrivateKey } from "node:crypto";

import { z } from "zod";

import { ConfigSection, type ConfigValue } from "../../../config/config-section.js";
import { csv, duration, flag, positiveInt } from "../../../config/env.schemas.js";

/**
 * RS256 signing key. Accepts the PEM base64-encoded on one line (recommended, survives
 * any env store) or the raw PEM with "\n" escapes. Outputs the PEM text.
 */
const rsaPrivateKey = z.string().transform((value, ctx) => {
  const pem = value.includes("-----BEGIN")
    ? value.replace(/\\n/g, "\n")
    : Buffer.from(value, "base64").toString("utf8");
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa") throw new Error(`expected an RSA key, got ${key.asymmetricKeyType}`);
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("RSA key must be at least 2048 bits");
    return pem;
  } catch (error) {
    ctx.addIssue({ code: "custom", message: `not a usable RSA private key (${(error as Error).message})` });
    return z.NEVER;
  }
});

const schema = z.object({
  // ── tokens ──────────────────────────────────────────────────────────────
  AUTH_JWT_PRIVATE_KEY: rsaPrivateKey,
  // "kid" in the JWT header and in /.well-known/jwks.json; change it when rotating the key
  AUTH_JWT_KEY_ID: z.string().min(1),
  AUTH_JWT_ISSUER: z.url().default("https://api.eazotel.com"),
  // `aud` of every token: the dashboard (web) and the mobile app use the same API and tokens
  AUTH_JWT_AUDIENCE: z.string().min(1).default("eazotel-app"),
  AUTH_ACCESS_TTL: duration.default("15m"),
  AUTH_REFRESH_TTL_DAYS: positiveInt.default(30),

  // ── refresh token: httpOnly cookie for browsers, JSON body for the mobile app ─
  AUTH_REFRESH_COOKIE_NAME: z.string().min(1).default("ez_rt"),
  // e.g. ".eazotel.com" to share the cookie across subdomains; empty = this host only
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  // false only for local http://localhost
  AUTH_COOKIE_SECURE: flag.default(true),

  // ── login methods ───────────────────────────────────────────────────────
  AUTH_BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  // OAuth client ids whose Google ID tokens we accept: the web client (dashboard; the
  // Android app also uses it as serverClientId) plus any other app client. Empty = Google off.
  AUTH_GOOGLE_CLIENT_IDS: csv
    .pipe(
      z.array(z.string().regex(/\.apps\.googleusercontent\.com$/, "each id must end with .apps.googleusercontent.com")),
    )
    .default([]),
  AUTH_OTP_TTL_SECONDS: positiveInt.default(300),
  AUTH_OTP_MAX_ATTEMPTS: positiveInt.default(5),
  // failed logins per IP + email in 15 minutes before 429
  AUTH_LOGIN_MAX_ATTEMPTS: positiveInt.default(10),

  // ── nexon compatibility (remove once nexon is retired) ─────────────────
  // HS256 secret nexon signs its logins with (= JWT_SECRETS in nexon settings.py and gian .env).
  // Used to accept old nexon tokens on every route, and to sign nexon-style tokens on the
  // legacy login paths (/eazotel/ceateuser…). Empty = both off.
  AUTH_LEGACY_JWT_SECRET: z.string().min(32, "must be the real nexon secret (32+ characters)").optional(),
  // lifetime of nexon-style tokens (nexon: 15 days)
  AUTH_LEGACY_TOKEN_TTL_DAYS: positiveInt.default(15),
  // also write nexon's SHA-256 password hash on every password set/change, so the same
  // password keeps working on nexon. Turn off once no client logs in through nexon.
  AUTH_LEGACY_PASSWORD_SYNC: flag.default(true),

  // ── platform staff (Eazotel + Fielmente team) ───────────────────────────
  // A Google sign-in with a verified email on one of these domains is "staff": it may see
  // every client and switch into a client account. Password logins never are.
  AUTH_STAFF_EMAIL_DOMAINS: csv
    .pipe(z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "a domain like eazotel.com")))
    .default(["eazotel.com", "fielmente.com"]),
  // lifetime of the access token a staff member gets when switching into a client account
  AUTH_IMPERSONATION_TTL: duration.default("1h"),
});

export const authConfig = new ConfigSection("auth", schema);
export type AuthConfig = ConfigValue<typeof authConfig>;
