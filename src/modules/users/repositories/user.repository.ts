import { ObjectIds } from "../../../shared/database/object-id.js";
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

  async findOldestAdminOfTenant(ndid: string): Promise<UserDocument | null> {
    return UserModel.findOne({ ndid, isAdmin: { $in: [true, "true", "True"] } })
      .sort({ _id: 1 })
      .lean<UserDocument>()
      .exec();
  }

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
