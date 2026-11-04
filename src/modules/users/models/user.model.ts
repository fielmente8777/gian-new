import { model, Schema, type Types } from "mongoose";

/**
 * Zucks_users, the dashboard users collection that nexon and gian already use.
 * Field names and value shapes stay exactly as nexon writes them while nexon runs
 * (README §9.1). `strict: false` keeps fields this schema does not list.
 */
export interface UserDocument {
  _id: Types.ObjectId;
  emailId: string;
  ndid?: string;
  phone?: string | null;
  displayName?: string | null;
  userName?: string | null;
  /** nexon password hash: unsalted SHA-256 hex. Read only through the auth module. */
  accesskey?: string | null;
  role?: string | null;
  /** stored as a boolean, older documents may hold the string "true" */
  isAdmin?: boolean | string;
  isActive?: boolean;
  google_id?: string | null;
  accessScope?: Record<string, unknown> | null;
  assigned_location?: { hid?: unknown; accessScope?: Record<string, unknown> | null }[];
  /** Python str(datetime): "2026-11-03 10:15:30.123456" */
  createdAt?: string;
  onboarding?: boolean;
}

const userSchema = new Schema<UserDocument>(
  {
    emailId: { type: String, required: true },
    ndid: String,
    phone: Schema.Types.Mixed,
    displayName: String,
    userName: String,
    accesskey: String,
    role: String,
    isAdmin: Schema.Types.Mixed,
    isActive: Boolean,
    google_id: String,
    accessScope: Schema.Types.Mixed,
    assigned_location: [Schema.Types.Mixed],
    createdAt: String,
    onboarding: Boolean,
  },
  { collection: "Zucks_users", strict: false, versionKey: false, timestamps: false, autoIndex: false },
);

// Used by every login. Declared for documentation; on the shared cluster it is built
// on purpose, never by the app (autoIndex is off for this schema).
userSchema.index({ emailId: 1 });
userSchema.index({ ndid: 1 });

export const UserModel = model<UserDocument>("User", userSchema);
