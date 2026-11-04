import { ObjectIds } from "../../../shared/database/object-id.js";
import { RefreshTokenModel, type RefreshTokenDocument } from "../models/refresh-token.model.js";
import type { NewRefreshToken, RefreshTokenStore, RevokeReason, StoredRefreshToken } from "../types/auth.types.js";

export class RefreshTokenRepository implements RefreshTokenStore {
  async create(token: NewRefreshToken): Promise<void> {
    await RefreshTokenModel.create({ ...token, userId: this.userId(token.userId) });
  }

  async findByHash(tokenHash: string): Promise<StoredRefreshToken | null> {
    const doc = await RefreshTokenModel.findOne({ tokenHash }).lean<RefreshTokenDocument>().exec();
    if (!doc) return null;
    return {
      tokenHash: doc.tokenHash,
      familyId: doc.familyId,
      userId: doc.userId.toString(),
      audience: doc.audience,
      staff: doc.staff === true,
      expiresAt: doc.expiresAt,
      revokedAt: doc.revokedAt ?? null,
      revokedReason: doc.revokedReason ?? null,
      replacedByHash: doc.replacedByHash ?? null,
    };
  }

  async markRotated(tokenHash: string, replacedByHash: string): Promise<boolean> {
    const result = await RefreshTokenModel.updateOne(
      { tokenHash, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: "rotated", replacedByHash } },
    ).exec();
    return result.modifiedCount === 1;
  }

  async revokeFamily(familyId: string, reason: RevokeReason): Promise<void> {
    await RefreshTokenModel.updateMany(
      { familyId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    ).exec();
  }

  async revokeAllForUser(userId: string, reason: RevokeReason, exceptFamilyId?: string): Promise<void> {
    await RefreshTokenModel.updateMany(
      {
        userId: this.userId(userId),
        revokedAt: null,
        ...(exceptFamilyId ? { familyId: { $ne: exceptFamilyId } } : {}),
      },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    ).exec();
  }

  ensureIndexes(): Promise<void> {
    return RefreshTokenModel.createIndexes();
  }

  private userId(id: string) {
    const _id = ObjectIds.parse(id);
    if (!_id) throw new Error(`Invalid user id "${id}"`);
    return _id;
  }
}
