import { generateKeyPairSync, randomUUID } from "node:crypto";

import { appConfig } from "../../../config/app.config.js";
import { Env } from "../../../config/env.js";
import { FULL_ACCESS_SCOPE } from "../../users/index.js";
import type { CreateOwnerInput, UserRecord, UsersPort } from "../../users/index.js";
import { authConfig, type AuthConfig } from "../config/auth.config.js";
import type {
  CredentialStore,
  GoogleIdentity,
  GoogleIdentityVerifier,
  NewRefreshToken,
  RefreshTokenStore,
  RevokeReason,
  StoredCredential,
  StoredRefreshToken,
} from "../types/auth.types.js";

// In-memory stand-ins for MongoDB and Google, so auth tests need no database or network.

export const LEGACY_SECRET = "test-legacy-secret-that-is-at-least-32-chars";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

/** Real config, parsed by the real schemas, with test values. */
export function testConfig(overrides: Record<string, string> = {}) {
  return Env.validate(
    { app: appConfig, auth: authConfig },
    {
      NODE_ENV: "test",
      CORS_ORIGINS: "http://dashboard.test",
      RATE_LIMIT_MAX: "0",
      AUTH_JWT_PRIVATE_KEY: Buffer.from(String(privateKey)).toString("base64"),
      AUTH_JWT_KEY_ID: "test-1",
      AUTH_COOKIE_SECURE: "false",
      AUTH_BCRYPT_ROUNDS: "10",
      AUTH_LEGACY_JWT_SECRET: LEGACY_SECRET,
      ...overrides,
    },
  );
}

export function testAuthConfig(overrides: Record<string, string> = {}): AuthConfig {
  return testConfig(overrides).auth;
}

export class InMemoryUsers implements UsersPort {
  readonly records = new Map<string, UserRecord>();
  readonly legacyHashes = new Map<string, string>();

  add(partial: Partial<UserRecord> & { email: string }, legacyHash?: string): UserRecord {
    const user: UserRecord = {
      id: randomUUID().replace(/-/g, "").slice(0, 24),
      ndid: randomUUID(),
      displayName: "Test User",
      userName: "Test User",
      phone: null,
      role: "superadmin",
      isAdmin: true,
      isActive: true,
      googleId: null,
      scopes: ["bookingEngine", "cms"],
      locations: [],
      onboarding: true,
      createdAt: null,
      ...partial,
    };
    this.records.set(user.id, user);
    if (legacyHash) this.legacyHashes.set(user.id, legacyHash);
    return user;
  }

  async findById(id: string) {
    return this.records.get(id) ?? null;
  }

  async findByEmail(email: string) {
    const all = [...this.records.values()];
    return (
      all.find((u) => u.email === email.trim()) ??
      all.find((u) => u.email.toLowerCase() === email.trim().toLowerCase()) ??
      null
    );
  }

  async findOwnerByNdid(ndid: string) {
    return [...this.records.values()].find((u) => u.ndid === ndid && u.isAdmin) ?? null;
  }

  async createOwner(input: CreateOwnerInput) {
    return this.add(
      {
        email: input.email,
        displayName: input.name,
        userName: input.name,
        phone: input.phone ?? null,
        googleId: input.googleId ?? null,
        scopes: Object.keys(FULL_ACCESS_SCOPE).sort(),
        onboarding: false,
      },
      input.legacyPasswordHash,
    );
  }

  async linkGoogleAccount(id: string, googleId: string) {
    const user = this.records.get(id);
    if (user) this.records.set(id, { ...user, googleId });
  }

  async getLegacyPasswordHash(id: string) {
    return this.legacyHashes.get(id) ?? null;
  }

  async setLegacyPasswordHash(id: string, hash: string) {
    this.legacyHashes.set(id, hash);
  }
}

export class InMemoryCredentials implements CredentialStore {
  readonly rows = new Map<string, StoredCredential>();

  async findByUserId(userId: string) {
    return this.rows.get(userId) ?? null;
  }

  async upsert(credential: StoredCredential) {
    this.rows.set(credential.userId, { ...credential });
  }
}

export class InMemoryRefreshTokens implements RefreshTokenStore {
  readonly rows = new Map<string, StoredRefreshToken>();
  /** platform / device stored with each token, by token hash */
  readonly clients = new Map<string, { platform?: string; deviceId?: string }>();

  async create(token: NewRefreshToken) {
    this.clients.set(token.tokenHash, { platform: token.platform, deviceId: token.deviceId });
    this.rows.set(token.tokenHash, {
      tokenHash: token.tokenHash,
      familyId: token.familyId,
      userId: token.userId,
      audience: token.audience,
      staff: token.staff,
      expiresAt: token.expiresAt,
      revokedAt: null,
      revokedReason: null,
      replacedByHash: null,
    });
  }

  async findByHash(tokenHash: string) {
    const row = this.rows.get(tokenHash);
    return row ? { ...row } : null;
  }

  async markRotated(tokenHash: string, replacedByHash: string) {
    const row = this.rows.get(tokenHash);
    if (!row || row.revokedAt) return false;
    Object.assign(row, { revokedAt: new Date(), revokedReason: "rotated", replacedByHash });
    return true;
  }

  async revokeFamily(familyId: string, reason: RevokeReason) {
    for (const row of this.rows.values()) {
      if (row.familyId === familyId && !row.revokedAt)
        Object.assign(row, { revokedAt: new Date(), revokedReason: reason });
    }
  }

  async revokeAllForUser(userId: string, reason: RevokeReason, exceptFamilyId?: string) {
    for (const row of this.rows.values()) {
      if (row.userId === userId && !row.revokedAt && row.familyId !== exceptFamilyId) {
        Object.assign(row, { revokedAt: new Date(), revokedReason: reason });
      }
    }
  }

  /** Pretend a token was revoked long ago (to step past the parallel-refresh grace window). */
  age(tokenHash: string, ms: number) {
    const row = this.rows.get(tokenHash);
    if (row?.revokedAt) row.revokedAt = new Date(row.revokedAt.getTime() - ms);
  }
}

/** Accepts tokens of the form "google:<email>:<sub>[:unverified]" (any client id). */
export class FakeGoogle implements GoogleIdentityVerifier {
  async verify(idToken: string): Promise<GoogleIdentity> {
    const [prefix, email, sub, flag] = idToken.split(":");
    if (prefix !== "google" || !email || !sub) throw new Error("bad token");
    return { email, sub, emailVerified: flag !== "unverified", name: "Google User", hostedDomain: null };
  }
}
