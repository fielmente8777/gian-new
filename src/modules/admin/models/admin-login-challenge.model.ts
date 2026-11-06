import { model, Schema, type Types } from "mongoose";

/**
 * admin_login_challenges: logins waiting for their email code. The code itself is never
 * stored, only its hash. MongoDB deletes each document after `expiresAt` (TTL index).
 */
export interface AdminLoginChallengeDocument {
  _id: Types.ObjectId;
  challengeId: string;
  adminId: Types.ObjectId;
  googleSub: string;
  codeHash: string;
  attempts: number;
  sends: number;
  lastSentAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

const challengeSchema = new Schema<AdminLoginChallengeDocument>(
  {
    challengeId: { type: String, required: true },
    adminId: { type: Schema.Types.ObjectId, required: true },
    googleSub: { type: String, required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    sends: { type: Number, default: 1 },
    lastSentAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  { collection: "admin_login_challenges", versionKey: false },
);

challengeSchema.index({ challengeId: 1 }, { unique: true });
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminLoginChallengeModel = model<AdminLoginChallengeDocument>("AdminLoginChallenge", challengeSchema);
