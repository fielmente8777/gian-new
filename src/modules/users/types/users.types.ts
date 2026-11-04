/** Access of a team member to one property (Zucks_users.assigned_location[]). */
export interface LocationAccess {
  hid: string;
  /** Names of the access-scope flags that are true for this property. */
  scopes: string[];
}

/**
 * A dashboard user as the rest of gian-new sees it: clean types, no password hash,
 * no Mongo document. Built from Zucks_users by UserMapper.
 */
export interface UserRecord {
  id: string;
  /** Owner (tenant) id. Every user of one hotel group shares it. */
  ndid: string | null;
  email: string;
  displayName: string | null;
  userName: string | null;
  phone: string | null;
  role: string | null;
  isAdmin: boolean;
  isActive: boolean;
  googleId: string | null;
  /** Names of the account-level access-scope flags that are true. */
  scopes: string[];
  locations: LocationAccess[];
  onboarding: boolean;
  createdAt: string | null;
}

export interface CreateOwnerInput {
  email: string;
  name: string;
  phone?: string;
  googleId?: string;
  /** Value for nexon's `accesskey` field (SHA-256 hex, or an unusable marker). */
  legacyPasswordHash: string;
}

/**
 * What other modules may do with users. Auth depends on this interface, not on the
 * users module's classes (README §3.4), so tests can pass an in-memory fake.
 */
export interface UsersPort {
  findById(id: string): Promise<UserRecord | null>;
  /** Exact match first (what nexon does), then case-insensitive. */
  findByEmail(email: string): Promise<UserRecord | null>;
  /** The account holder of a tenant: its oldest admin user (nexon creates the owner first). */
  findOwnerByNdid(ndid: string): Promise<UserRecord | null>;
  createOwner(input: CreateOwnerInput): Promise<UserRecord>;
  linkGoogleAccount(id: string, googleId: string): Promise<void>;
  /** nexon's password hash (`accesskey`). Only the auth module reads or writes it. */
  getLegacyPasswordHash(id: string): Promise<string | null>;
  setLegacyPasswordHash(id: string, hash: string): Promise<void>;
}
