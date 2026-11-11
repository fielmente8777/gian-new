import type { FilterQuery } from "mongoose";

import { ProfileModel, type ProfileDocument, type PropertyDocument } from "../models/profile.model.js";
import type {
  EditablePropertyField,
  ProfileChanges,
  ProfilePage,
  ProfileRecord,
  ProfileSearch,
  PropertyRecord,
} from "../types/profiles.types.js";

/** Where each property field lives inside `hotels.<hId>`. */
const PROPERTY_PATHS: Record<EditablePropertyField, string> = {
  name: "local",
  city: "city",
  state: "state",
  country: "country",
  pinCode: "pinCode",
};

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * All Zucks_profile queries. Writes $set named paths only, never a whole document, because
 * nexon and gian write the same documents. Lookups match `ndid` or `uId`, since older
 * profiles may carry only one of them.
 */
export class ProfileRepository {
  async list({ limit, after, search, ndids, excludeNdids, orNdids }: ProfileSearch): Promise<ProfilePage> {
    const conditions: FilterQuery<ProfileDocument>[] = [];
    if (ndids) conditions.push(ProfileRepository.byNdids(ndids));
    if (excludeNdids?.length) conditions.push({ ndid: { $nin: excludeNdids } });
    if (after) conditions.push({ ndid: { $gt: after } });
    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");
      conditions.push({
        $or: [
          { hotelName: pattern },
          { domain: pattern },
          { hotelEmail: pattern },
          { ndid: search },
          { uId: search },
          ...(orNdids?.length ? [{ ndid: { $in: orNdids } }] : []),
        ],
      });
    }

    // ordered by ndid so the cursor is stable; one extra row says whether more exist
    const docs = await ProfileModel.find(conditions.length ? { $and: conditions } : {})
      .sort({ ndid: 1 })
      .limit(limit + 1)
      .lean<ProfileDocument[]>()
      .exec();
    const items = docs
      .slice(0, limit)
      .map((doc) => this.toRecord(doc))
      .filter((r) => r !== null);
    return { items, nextCursor: docs.length > limit ? (items.at(-1)?.ndid ?? null) : null };
  }

  async findByNdid(ndid: string): Promise<ProfileRecord | null> {
    const doc = await ProfileModel.findOne(ProfileRepository.byNdids([ndid]))
      .lean<ProfileDocument>()
      .exec();
    return doc ? this.toRecord(doc) : null;
  }

  async update(ndid: string, { profile, properties }: ProfileChanges): Promise<ProfileRecord | null> {
    const set: Record<string, string | null> = { ...profile };
    for (const [hid, fields] of Object.entries(properties)) {
      for (const [field, value] of Object.entries(fields)) {
        set[`hotels.${hid}.${PROPERTY_PATHS[field as EditablePropertyField]}`] = value ?? null;
      }
    }
    const doc = await ProfileModel.findOneAndUpdate(
      ProfileRepository.byNdids([ndid]),
      { $set: set },
      { returnDocument: "after" },
    )
      .lean<ProfileDocument>()
      .exec();
    return doc ? this.toRecord(doc) : null;
  }

  private static byNdids(ndids: string[]): FilterQuery<ProfileDocument> {
    return { $or: [{ ndid: { $in: ndids } }, { uId: { $in: ndids } }] };
  }

  private toRecord(doc: ProfileDocument): ProfileRecord | null {
    const ndid = text(doc.ndid) ?? text(doc.uId);
    if (!ndid) return null;
    return {
      ndid,
      hotelName: text(doc.hotelName),
      hotelDescription: text(doc.hotelDescription),
      hotelEmail: text(doc.hotelEmail),
      hotelPhone: text(doc.hotelPhone),
      marketingEmail: text(doc.marketingEmail),
      domain: text(doc.domain),
      currency: text(doc.currency),
      isVerified: doc.isVerified === true,
      plan: doc.plan
        ? {
            name: text(doc.plan.name),
            activationDate: text(doc.plan.activationDate),
            expiryDate: text(doc.plan.expiryDate),
          }
        : null,
      onboardedAt: onboardedAt(doc.onBoardinDate),
      properties: Object.entries(doc.hotels ?? {}).map(([hid, property]) => toProperty(hid, property ?? {})),
    };
  }
}

function toProperty(hid: string, property: PropertyDocument): PropertyRecord {
  return {
    hid,
    name: text(property.local) ?? text(property.location),
    city: text(property.city),
    state: text(property.state),
    country: text(property.country),
    pinCode: text(property.pinCode),
  };
}

/** Strings as they are; numbers (old phone and pin code values) as text; anything else is null. */
function text(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function onboardedAt(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}
