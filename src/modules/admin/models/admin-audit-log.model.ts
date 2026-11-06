import { model, Schema, type Types } from "mongoose";

import { ADMIN_AUDIT_ACTIONS, type AdminAuditAction, type AuditChanges } from "../types/admin.types.js";

/**
 * admin_audit_logs: who did what in the admin console. Nothing updates or deletes these lines,
 * and pages are read newest first by _id, which is why each index ends in _id.
 */
export interface AdminAuditLogDocument {
  _id: Types.ObjectId;
  action: AdminAuditAction;
  actorId: string | null;
  actorEmail: string | null;
  targetId: string | null;
  targetEmail: string | null;
  changes: AuditChanges | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  at: Date;
}

const adminAuditLogSchema = new Schema<AdminAuditLogDocument>(
  {
    action: { type: String, enum: ADMIN_AUDIT_ACTIONS, required: true },
    actorId: { type: String, default: null },
    actorEmail: { type: String, default: null },
    targetId: { type: String, default: null },
    targetEmail: { type: String, default: null },
    changes: { type: Schema.Types.Mixed, default: null },
    details: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { collection: "admin_audit_logs", versionKey: false },
);

adminAuditLogSchema.index({ action: 1, _id: -1 });
adminAuditLogSchema.index({ actorEmail: 1, _id: -1 });
adminAuditLogSchema.index({ targetEmail: 1, _id: -1 });

export const AdminAuditLogModel = model<AdminAuditLogDocument>("AdminAuditLog", adminAuditLogSchema);
