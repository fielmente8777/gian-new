/** One property (location) of a client. */
export interface PropertyRecord {
  hid: string;
  name: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  pinCode: string | null;
}

/** A client: one hotel group (Zucks_profile), with all its properties. */
export interface ProfileRecord {
  /** the tenant id every account and record of this hotel group carries */
  ndid: string;
  hotelName: string | null;
  hotelDescription: string | null;
  hotelEmail: string | null;
  hotelPhone: string | null;
  marketingEmail: string | null;
  domain: string | null;
  currency: string | null;
  isVerified: boolean;
  /** As recorded on the profile; the subscriptions module will own this later. */
  plan: { name: string | null; activationDate: string | null; expiryDate: string | null } | null;
  onboardedAt: string | null;
  properties: PropertyRecord[];
}

export type EditableProfileField = "hotelDescription" | "hotelEmail" | "hotelPhone" | "marketingEmail";
export type EditablePropertyField = "name" | "city" | "state" | "country" | "pinCode";

export interface ProfileChanges {
  profile: Partial<Record<EditableProfileField, string | null>>;
  /** keyed by hid */
  properties: Record<string, Partial<Record<EditablePropertyField, string | null>>>;
}

export interface ProfileSearch {
  limit: number;
  /** ndid of the last client already shown; returns the ones after it */
  after?: string;
  /** part of the hotel name, domain or hotel email, or an exact ndid */
  search?: string;
  /** Only these clients. Undefined means every client. */
  ndids?: string[];
}

export interface ProfilePage {
  items: ProfileRecord[];
  nextCursor: string | null;
}

/** What other modules may do with client profiles. */
export interface ProfilesPort {
  list(search: ProfileSearch): Promise<ProfilePage>;
  findByNdid(ndid: string): Promise<ProfileRecord | null>;
  /** Writes only the fields given. Null when the client does not exist. */
  update(ndid: string, changes: ProfileChanges): Promise<ProfileRecord | null>;
}
