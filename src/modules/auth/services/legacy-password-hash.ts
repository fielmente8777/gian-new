import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { NEXON_GOOGLE_DEFAULT_PASSWORD } from "../constants/auth.constants.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * nexon's password format: unsalted SHA-256 hex in Zucks_users.accesskey. Weak (fast to
 * brute-force), so gian-new only reads it to verify and upgrade, and writes it only while
 * AUTH_LEGACY_PASSWORD_SYNC is on. Delete with nexon.
 */
export class LegacyPasswordHash {
  /** Hash every account nexon created through Google sign-up shares (password "Eazotel@123"). */
  static readonly googleDefault = LegacyPasswordHash.of(NEXON_GOOGLE_DEFAULT_PASSWORD);

  static of(plain: string): string {
    return createHash("sha256").update(plain, "utf8").digest("hex");
  }

  /** Constant-time comparison of a password with a stored nexon hash. */
  static matches(plain: string, stored: string): boolean {
    if (!SHA256_HEX.test(stored)) return false;
    return timingSafeEqual(Buffer.from(LegacyPasswordHash.of(plain), "hex"), Buffer.from(stored, "hex"));
  }

  /** Can a password log in with this stored value? False for unusable markers and the Google default. */
  static isUsable(stored: string | null): stored is string {
    return stored !== null && SHA256_HEX.test(stored) && stored !== LegacyPasswordHash.googleDefault;
  }

  /**
   * A value for `accesskey` that no password matches ("!" is never part of a SHA-256 hex).
   * Used for Google-only accounts and once nexon password sync is off.
   */
  static unusable(): string {
    return `!disabled:${randomBytes(16).toString("hex")}`;
  }
}
