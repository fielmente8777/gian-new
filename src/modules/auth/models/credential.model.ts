import { model, Schema, type Types } from "mongoose";

/**
 * auth_credentials: bcrypt password hashes written by gian-new. New collection, owned by
 * the auth module (nexon never reads it). One document per user.
 */
export interface CredentialDocument {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  passwordHash: string;
  /** Zucks_users.accesskey when passwordHash was written; see CredentialService */
  legacyHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const credentialSchema = new Schema<CredentialDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    passwordHash: { type: String, required: true },
    legacyHash: { type: String, default: null },
  },
  { collection: "auth_credentials", versionKey: false, timestamps: true },
);

credentialSchema.index({ userId: 1 }, { unique: true });

export const CredentialModel = model<CredentialDocument>("AuthCredential", credentialSchema);
