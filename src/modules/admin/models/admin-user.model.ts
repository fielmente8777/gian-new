import { model, Schema, type Types } from "mongoose";

import type { AdminRole, AdminStatus, AssignedProperty } from "../types/admin.types.js";

/**
 * admin_users: the Eazotel team. Completely separate from Zucks_users (hotel accounts), so a
 * staff login never creates a hotel, an ndid or a client record. Nobody signs up here: a
 * super admin adds people, and the first super admins come from scripts/create-admin.ts.
 */
export interface AdminUserDocument {
  _id: Types.ObjectId;
  /** always lowercase */
  email: string;
  name: string | null;
  role: AdminRole;
  status: AdminStatus;
  /** Google's stable account id, linked at the first login */
  googleId: string | null;
  advancedPermissions: string[];
  assignedProperties: AssignedProperty[];
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const adminUserSchema = new Schema<AdminUserDocument>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, default: null },
    role: { type: String, enum: ["super_admin", "admin"], required: true },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    googleId: { type: String, default: null },
    advancedPermissions: { type: [String], default: [] },
    assignedProperties: {
      type: [new Schema<AssignedProperty>({ ndid: String, hid: String }, { _id: false })],
      default: [],
    },
    lastLoginAt: { type: Date, default: null },
  },
  { collection: "admin_users", versionKey: false, timestamps: true },
);

adminUserSchema.index({ email: 1 }, { unique: true });

export const AdminUserModel = model<AdminUserDocument>("AdminUser", adminUserSchema);
