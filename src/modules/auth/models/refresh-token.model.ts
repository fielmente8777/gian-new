import { model, Schema, type Types } from "mongoose";

import type { RevokeReason } from "../types/auth.types.js";

/**
 * auth_refresh_tokens: one document per issued refresh token (only its hash). Documents
 * of one login share `familyId`. MongoDB deletes them by itself after `expiresAt` (TTL index).
 */
export interface RefreshTokenDocument {
  _id: Types.ObjectId;
  tokenHash: string;
  familyId: string;
  userId: Types.ObjectId;
  audience: string;
  staff: boolean;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: RevokeReason | null;
  replacedByHash: string | null;
  platform?: string;
  deviceId?: string;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const refreshTokenSchema = new Schema<RefreshTokenDocument>(
  {
    tokenHash: { type: String, required: true },
    familyId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    audience: { type: String, required: true },
    staff: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    replacedByHash: { type: String, default: null },
    platform: { type: String, enum: ["web", "android", "ios"], default: "web" },
    deviceId: String,
    ip: String,
    userAgent: String,
  },
  { collection: "auth_refresh_tokens", versionKey: false, timestamps: true },
);

refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ familyId: 1 });
refreshTokenSchema.index({ userId: 1, revokedAt: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshTokenModel = model<RefreshTokenDocument>("AuthRefreshToken", refreshTokenSchema);
