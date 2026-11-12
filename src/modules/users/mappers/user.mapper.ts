import type { UserDocument } from "../models/user.model.js";
import type { LocationAccess, UserRecord } from "../types/users.types.js";

/** Zucks_users document → UserRecord. Tolerates the mixed value types older nexon code wrote. */
export class UserMapper {
  static toRecord(doc: UserDocument): UserRecord {
    return {
      id: doc._id.toString(),
      ndid: UserMapper.text(doc.ndid),
      email: doc.emailId,
      displayName: UserMapper.text(doc.displayName),
      userName: UserMapper.text(doc.userName),
      // a blank phone (some old rows) is no phone
      phone: doc.phone === undefined || doc.phone === null || String(doc.phone).trim() === "" ? null : String(doc.phone),
      role: UserMapper.text(doc.role),
      isAdmin: UserMapper.bool(doc.isAdmin),
      // nexon treats a missing isActive as active
      isActive: doc.isActive !== false,
      googleId: UserMapper.text(doc.google_id),
      scopes: UserMapper.trueKeys(doc.accessScope),
      locations: (doc.assigned_location ?? [])
        .filter((location) => location?.hid !== undefined && location.hid !== null && location.hid !== "")
        .map(
          (location): LocationAccess => ({
            hid: String(location.hid),
            scopes: UserMapper.trueKeys(location.accessScope),
          }),
        ),
      onboarding: doc.onboarding === true,
      createdAt: UserMapper.text(doc.createdAt),
    };
  }

  private static text(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
  }

  /** nexon's to_bool: true for true and for the string "true" in any case. */
  private static bool(value: unknown): boolean {
    return String(value).toLowerCase() === "true";
  }

  private static trueKeys(scope: Record<string, unknown> | null | undefined): string[] {
    if (!scope || typeof scope !== "object") return [];
    return Object.entries(scope)
      .filter(([, value]) => UserMapper.bool(value))
      .map(([key]) => key)
      .sort();
  }
}
