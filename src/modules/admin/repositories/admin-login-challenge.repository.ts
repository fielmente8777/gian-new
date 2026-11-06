import { ObjectIds } from "../../../shared/database/object-id.js";
import { AdminLoginChallengeModel, type AdminLoginChallengeDocument } from "../models/admin-login-challenge.model.js";
import type { NewOtpChallenge, OtpChallenge, OtpChallengeStore, OtpCodeReplacement } from "../types/admin.types.js";

export class AdminLoginChallengeRepository implements OtpChallengeStore {
  async create({ id, adminId, ...rest }: NewOtpChallenge): Promise<void> {
    const _adminId = ObjectIds.parse(adminId);
    if (!_adminId) throw new Error(`Invalid admin id "${adminId}"`);
    await AdminLoginChallengeModel.create({ ...rest, challengeId: id, adminId: _adminId });
  }

  async find(id: string): Promise<OtpChallenge | null> {
    const doc = await AdminLoginChallengeModel.findOne({ challengeId: id }).lean<AdminLoginChallengeDocument>().exec();
    if (!doc) return null;
    return {
      id: doc.challengeId,
      adminId: doc.adminId.toString(),
      googleSub: doc.googleSub,
      codeHash: doc.codeHash,
      attempts: doc.attempts,
      sends: doc.sends,
      lastSentAt: doc.lastSentAt,
      expiresAt: doc.expiresAt,
      consumedAt: doc.consumedAt ?? null,
    };
  }

  async recordAttempt(id: string, maxAttempts: number): Promise<boolean> {
    const result = await AdminLoginChallengeModel.updateOne(
      { challengeId: id, consumedAt: null, attempts: { $lt: maxAttempts } },
      { $inc: { attempts: 1 } },
    ).exec();
    return result.modifiedCount === 1;
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const result = await AdminLoginChallengeModel.updateOne(
      { challengeId: id, consumedAt: null },
      { $set: { consumedAt: at } },
    ).exec();
    return result.modifiedCount === 1;
  }

  async replaceCode(id: string, code: OtpCodeReplacement, sentBefore: Date, maxSends: number): Promise<boolean> {
    const result = await AdminLoginChallengeModel.updateOne(
      { challengeId: id, consumedAt: null, lastSentAt: { $lte: sentBefore }, sends: { $lt: maxSends } },
      { $set: code, $inc: { sends: 1 } },
    ).exec();
    return result.modifiedCount === 1;
  }

  async delete(id: string): Promise<void> {
    await AdminLoginChallengeModel.deleteOne({ challengeId: id }).exec();
  }

  ensureIndexes(): Promise<void> {
    return AdminLoginChallengeModel.createIndexes();
  }
}
