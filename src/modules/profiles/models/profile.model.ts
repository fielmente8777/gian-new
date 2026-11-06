import { model, Schema, type Types } from "mongoose";

/** One property (location) of a hotel group, as nexon stores it under `hotels.<hId>`. */
export interface PropertyDocument {
  /** The property's name. Older nexon code sometimes wrote the street address here. */
  local?: unknown;
  /** Written by nexon's edit-location instead of `local`. */
  location?: unknown;
  city?: unknown;
  state?: unknown;
  country?: unknown;
  pinCode?: unknown;
}

/**
 * Zucks_profile: one hotel group (a client), shared with nexon and gian. Field names stay
 * exactly as they write them. `strict: false` keeps every field this schema does not list,
 * and writes only ever $set named paths.
 */
export interface ProfileDocument {
  _id: Types.ObjectId;
  ndid?: string;
  /** Same value as ndid; some code looks the profile up by this instead. */
  uId?: string;
  domain?: string | null;
  hotelName?: string | null;
  hotelDescription?: string | null;
  hotelEmail?: string | null;
  hotelPhone?: unknown;
  marketingEmail?: string | null;
  currency?: string | null;
  isVerified?: boolean;
  /** dates are "yy-mm-dd" strings, as nexon writes them */
  plan?: { name?: unknown; activationDate?: unknown; expiryDate?: unknown } | null;
  subscriptionId?: Types.ObjectId | null;
  onBoardinDate?: Date | string | null;
  /** keyed by hId, an 8-digit string */
  hotels?: Record<string, PropertyDocument | null> | null;
}

const profileSchema = new Schema<ProfileDocument>(
  {
    ndid: String,
    uId: String,
    domain: String,
    hotelName: String,
    hotelDescription: String,
    hotelEmail: String,
    hotelPhone: Schema.Types.Mixed,
    marketingEmail: String,
    currency: String,
    isVerified: Boolean,
    plan: Schema.Types.Mixed,
    subscriptionId: Schema.Types.ObjectId,
    onBoardinDate: Schema.Types.Mixed,
    hotels: Schema.Types.Mixed,
  },
  { collection: "Zucks_profile", strict: false, versionKey: false, timestamps: false, autoIndex: false },
);

profileSchema.index({ ndid: 1 });

export const ProfileModel = model<ProfileDocument>("Profile", profileSchema);
