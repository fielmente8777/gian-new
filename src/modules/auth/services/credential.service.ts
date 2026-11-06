import type { UsersPort } from "../../users/index.js";
import type { CredentialStore } from "../types/auth.types.js";
import { LegacyPasswordHash } from "./legacy-password-hash.js";
import type { PasswordService } from "./password.service.js";

type LegacyHashes = Pick<UsersPort, "getLegacyPasswordHash" | "setLegacyPasswordHash">;

/**
 * Password checks during the migration, when two systems can change a password:
 *
 * - gian-new keeps a bcrypt hash in auth_credentials, together with a snapshot of nexon's
 *   accesskey at the moment it was written (`legacyHash`).
 * - If accesskey still equals the snapshot, nobody changed the password through nexon, so
 *   the bcrypt hash is the truth.
 * - If it differs (or there is no credential yet), nexon's SHA-256 is the truth. A correct
 *   password is then upgraded: a new bcrypt hash plus a new snapshot.
 *
 * So the first login through gian-new upgrades the hash, and a password changed in nexon
 * keeps working in gian-new, without any migration script.
 */
export class CredentialService {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly users: LegacyHashes,
    private readonly passwords: PasswordService,
    private readonly syncLegacy: boolean,
  ) {}

  async verify(userId: string, plain: string): Promise<boolean> {
    const [legacyHash, credential] = await Promise.all([
      this.users.getLegacyPasswordHash(userId),
      this.credentials.findByUserId(userId),
    ]);

    if (credential && credential.legacyHash === legacyHash) {
      return this.passwords.verify(plain, credential.passwordHash);
    }

    if (!LegacyPasswordHash.isUsable(legacyHash) || !LegacyPasswordHash.matches(plain, legacyHash)) {
      await this.passwords.burn(plain);
      return false;
    }

    await this.credentials.upsert({ userId, passwordHash: await this.passwords.hash(plain), legacyHash });
    return true;
  }

  /**
   * Sets a new password. The credential is written first: if the second write fails,
   * the snapshot no longer matches and verify() falls back to nexon's (old) hash, so the
   * account is never locked out.
   */
  async setPassword(userId: string, plain: string): Promise<void> {
    const legacyHash = this.syncLegacy ? LegacyPasswordHash.of(plain) : LegacyPasswordHash.unusable();
    await this.credentials.upsert({ userId, passwordHash: await this.passwords.hash(plain), legacyHash });
    await this.users.setLegacyPasswordHash(userId, legacyHash);
  }
}
