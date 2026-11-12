import { ObjectIds } from "../../../shared/database/object-id.js";
import { emailDomainPattern } from "../../../shared/utils/email-domains.js";
import { UserModel, type UserDocument } from "../models/user.model.js";

/** All Zucks_users queries. Writes use $set on named fields only, never a full-document save. */
export class UserRepository {
  async findById(id: string): Promise<UserDocument | null> {
    const _id = ObjectIds.parse(id);
    return _id ? UserModel.findById(_id).lean<UserDocument>().exec() : null;
  }

  async findByEmailExact(email: string): Promise<UserDocument | null> {
    return UserModel.findOne({ emailId: email }).lean<UserDocument>().exec();
  }

  /** Oldest match, so duplicates that nexon created by mistake resolve to the original account. */
  async findByEmailIgnoringCase(email: string): Promise<UserDocument | null> {
    const pattern = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    return UserModel.findOne({ emailId: pattern }).sort({ _id: 1 }).lean<UserDocument>().exec();
  }

  /** The owner is the oldest admin of the tenant, as in findOldestAdminOfTenant; team members never count. */
  async ownerNdidsWithEmailDomains(domains: string[]): Promise<string[]> {
    const rows = await UserModel.aggregate<{ _id: unknown }>([
      { $match: { ndid: { $type: "string", $ne: "" }, isAdmin: { $in: [true, "true", "True"] } } },
      { $sort: { _id: 1 } },
      { $group: { _id: "$ndid", email: { $first: "$emailId" } } },
      { $match: { email: emailDomainPattern(domains) } },
    ]).exec();
    return rows.map((r) => r._id).filter((n): n is string => typeof n === "string");
  }

  async ndidsByEmail(text: string, limit: number): Promise<string[]> {
    const pattern = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const ndids: unknown[] = await UserModel.distinct("ndid", { emailId: pattern }).exec();
    return ndids.filter((n): n is string => typeof n === "string" && n.trim() !== "").slice(0, limit);
  }

  async findOldestAdminOfTenant(ndid: string): Promise<UserDocument | null> {
    return UserModel.findOne({ ndid, isAdmin: { $in: [true, "true", "True"] } })
      .sort({ _id: 1 })
      .lean<UserDocument>()
      .exec();
  }

  /** Every user of one tenant, oldest first (the first admin is the account holder). */
  async findAllOfTenant(ndid: string): Promise<UserDocument[]> {
    return UserModel.find({ ndid }).sort({ _id: 1 }).lean<UserDocument[]>().exec();
  }

  /**
   * Sets `phone`. With onlyIfEmpty the filter itself requires the stored phone to be missing,
   * null or blank, so a number that is already there (or written meanwhile) is never replaced.
   * True when the document was changed.
   */
  async setPhone(id: string, phone: string | null, onlyIfEmpty: boolean): Promise<boolean> {
    const _id = ObjectIds.parse(id);
    if (!_id) return false;
    const filter = onlyIfEmpty ? { _id, $or: UserRepository.NO_PHONE } : { _id };
    const result = await UserModel.updateOne(filter, { $set: { phone } }).exec();
    return result.modifiedCount > 0;
  }

  /**
   * Account holders (oldest admin of each tenant) with no phone, oldest tenant first. Team
   * members never count: only the owner's number can be taken from the hotel's profile.
   */
  async ownersWithoutPhone(limit: number): Promise<UserDocument[]> {
    return UserModel.aggregate<UserDocument>([
      { $match: { ndid: { $type: "string", $ne: "" }, isAdmin: { $in: [true, "true", "True"] } } },
      { $sort: { _id: 1 } },
      { $group: { _id: "$ndid", owner: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$owner" } },
      { $match: { $or: UserRepository.NO_PHONE } },
      { $sort: { _id: 1 } },
      { $limit: limit },
    ]).exec();
  }

  /** nexon writes no phone at all for Google sign-ups; some old rows hold null or "". */
  private static readonly NO_PHONE = [{ phone: { $exists: false } }, { phone: null }, { phone: /^\s*$/ }];

  async create(doc: Omit<UserDocument, "_id">): Promise<UserDocument> {
    const created = await UserModel.create(doc);
    return created.toObject<UserDocument>();
  }

  async setGoogleId(id: string, googleId: string): Promise<void> {
    await UserModel.updateOne({ _id: ObjectIds.parse(id) }, { $set: { google_id: googleId } }).exec();
  }

  async getAccesskey(id: string): Promise<string | null> {
    const _id = ObjectIds.parse(id);
    if (!_id) return null;
    const doc = await UserModel.findById(_id, { accesskey: 1 }).lean<Pick<UserDocument, "accesskey">>().exec();
    return typeof doc?.accesskey === "string" && doc.accesskey !== "" ? doc.accesskey : null;
  }

  async setAccesskey(id: string, hash: string): Promise<void> {
    await UserModel.updateOne({ _id: ObjectIds.parse(id) }, { $set: { accesskey: hash } }).exec();
  }
}
