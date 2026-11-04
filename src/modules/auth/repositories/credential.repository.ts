import { ObjectIds } from "../../../shared/database/object-id.js";
import { CredentialModel, type CredentialDocument } from "../models/credential.model.js";
import type { CredentialStore, StoredCredential } from "../types/auth.types.js";

export class CredentialRepository implements CredentialStore {
  async findByUserId(userId: string): Promise<StoredCredential | null> {
    const _id = ObjectIds.parse(userId);
    if (!_id) return null;
    const doc = await CredentialModel.findOne({ userId: _id }).lean<CredentialDocument>().exec();
    return doc ? { userId, passwordHash: doc.passwordHash, legacyHash: doc.legacyHash ?? null } : null;
  }

  async upsert({ userId, passwordHash, legacyHash }: StoredCredential): Promise<void> {
    const _id = ObjectIds.parse(userId);
    if (!_id) throw new Error(`Invalid user id "${userId}"`);
    await CredentialModel.updateOne({ userId: _id }, { $set: { passwordHash, legacyHash } }, { upsert: true }).exec();
  }

  ensureIndexes(): Promise<void> {
    return CredentialModel.createIndexes();
  }
}
