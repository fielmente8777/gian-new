import { ObjectIds } from "../../../shared/database/object-id.js";
import type { AdminAdvancedPermission } from "../constants/admin-permissions.js";
import { AdminUserModel, type AdminUserDocument } from "../models/admin-user.model.js";
import type { AdminRecord, AdminUserStore, NewAdmin, NewTeamMember, TeamMemberChanges } from "../types/admin.types.js";

const DUPLICATE_KEY = 11000;

export class AdminUserRepository implements AdminUserStore {
  async findById(id: string): Promise<AdminRecord | null> {
    const _id = ObjectIds.parse(id);
    if (!_id) return null;
    const doc = await AdminUserModel.findById(_id).lean<AdminUserDocument>().exec();
    return doc ? this.toRecord(doc) : null;
  }

  async findByEmail(email: string): Promise<AdminRecord | null> {
    const doc = await AdminUserModel.findOne({ email: email.trim().toLowerCase() }).lean<AdminUserDocument>().exec();
    return doc ? this.toRecord(doc) : null;
  }

  async recordLogin(id: string, googleId: string, at: Date): Promise<void> {
    await AdminUserModel.updateOne({ _id: ObjectIds.parse(id) }, { $set: { googleId, lastLoginAt: at } }).exec();
  }

  async list(): Promise<AdminRecord[]> {
    const docs = await AdminUserModel.find().sort({ email: 1 }).lean<AdminUserDocument[]>().exec();
    return docs.map((doc) => this.toRecord(doc));
  }

  async create(member: NewTeamMember): Promise<AdminRecord | null> {
    try {
      const doc = await AdminUserModel.create(member);
      return this.toRecord(doc.toObject());
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) return null;
      throw error;
    }
  }

  async update(id: string, changes: TeamMemberChanges): Promise<AdminRecord | null> {
    const doc = await AdminUserModel.findOneAndUpdate(
      { _id: ObjectIds.parse(id) },
      { $set: changes },
      { returnDocument: "after" },
    )
      .lean<AdminUserDocument>()
      .exec();
    return doc ? this.toRecord(doc) : null;
  }

  countActiveSuperAdmins(): Promise<number> {
    return AdminUserModel.countDocuments({ role: "super_admin", status: "active" }).exec();
  }

  /** scripts/create-admin.ts: adds the person, or restores an existing one to this role. */
  async upsertActive({ email, name, role }: NewAdmin): Promise<AdminRecord> {
    const doc = await AdminUserModel.findOneAndUpdate(
      { email: email.trim().toLowerCase() },
      { $set: { role, status: "active", ...(name ? { name } : {}) } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    )
      .lean<AdminUserDocument>()
      .exec();
    if (!doc) throw new Error(`Could not save admin ${email}`);
    return this.toRecord(doc);
  }

  ensureIndexes(): Promise<void> {
    return AdminUserModel.createIndexes();
  }

  private toRecord(doc: AdminUserDocument): AdminRecord {
    return {
      id: doc._id.toString(),
      email: doc.email,
      name: doc.name ?? null,
      role: doc.role,
      status: doc.status,
      googleId: doc.googleId ?? null,
      advancedPermissions: (doc.advancedPermissions ?? []) as AdminAdvancedPermission[],
      assignedProperties: (doc.assignedProperties ?? []).map(({ ndid, hid }) => ({ ndid, hid })),
      lastLoginAt: doc.lastLoginAt ?? null,
    };
  }
}
