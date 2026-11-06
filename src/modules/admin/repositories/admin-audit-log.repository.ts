import type { FilterQuery } from "mongoose";

import { ObjectIds } from "../../../shared/database/object-id.js";
import { AdminAuditLogModel, type AdminAuditLogDocument } from "../models/admin-audit-log.model.js";
import type {
  AdminAuditEntry,
  AdminAuditPage,
  AdminAuditQuery,
  AdminAuditStore,
  NewAdminAuditEntry,
} from "../types/admin.types.js";

export class AdminAuditLogRepository implements AdminAuditStore {
  async create(entry: NewAdminAuditEntry, at: Date): Promise<void> {
    await AdminAuditLogModel.create({ ...entry, at });
  }

  async list({ limit, before, action, email }: AdminAuditQuery): Promise<AdminAuditPage> {
    const filter: FilterQuery<AdminAuditLogDocument> = {};
    if (before) filter._id = { $lt: ObjectIds.parse(before) };
    if (action) filter.action = action;
    if (email) filter.$or = [{ actorEmail: email }, { targetEmail: email }];

    // one extra row tells us whether an older page exists
    const docs = await AdminAuditLogModel.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean<AdminAuditLogDocument[]>()
      .exec();
    const items = docs.slice(0, limit).map((doc) => this.toEntry(doc));
    return { items, nextCursor: docs.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  ensureIndexes(): Promise<void> {
    return AdminAuditLogModel.createIndexes();
  }

  private toEntry(doc: AdminAuditLogDocument): AdminAuditEntry {
    return {
      id: doc._id.toString(),
      action: doc.action,
      actorId: doc.actorId ?? null,
      actorEmail: doc.actorEmail ?? null,
      targetId: doc.targetId ?? null,
      targetEmail: doc.targetEmail ?? null,
      changes: doc.changes ?? null,
      details: doc.details ?? null,
      ip: doc.ip ?? null,
      at: doc.at,
    };
  }
}
