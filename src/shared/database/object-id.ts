import { Types } from "mongoose";

/** Turns a string id into an ObjectId, or null when it is not a valid one (so lookups miss instead of throwing). */
export class ObjectIds {
  static parse(id: string): Types.ObjectId | null {
    return Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id) ? new Types.ObjectId(id) : null;
  }
}
