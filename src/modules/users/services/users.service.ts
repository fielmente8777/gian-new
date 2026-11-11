import { randomUUID } from "node:crypto";

import { FULL_ACCESS_SCOPE, OWNER_ROLE } from "../constants/access-scope.js";
import { UserMapper } from "../mappers/user.mapper.js";
import type { UserRepository } from "../repositories/user.repository.js";
import type { CreateOwnerInput, UserRecord, UsersPort } from "../types/users.types.js";

/** Business rules for dashboard users. The public face of the users module (UsersPort). */
export class UsersService implements UsersPort {
  constructor(private readonly users: UserRepository) {}

  async findById(id: string): Promise<UserRecord | null> {
    const doc = await this.users.findById(id);
    return doc ? UserMapper.toRecord(doc) : null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const trimmed = email.trim();
    if (!trimmed) return null;
    const doc = (await this.users.findByEmailExact(trimmed)) ?? (await this.users.findByEmailIgnoringCase(trimmed));
    return doc ? UserMapper.toRecord(doc) : null;
  }

  ownerNdidsWithEmailDomains(domains: string[]): Promise<string[]> {
    return domains.length ? this.users.ownerNdidsWithEmailDomains(domains) : Promise.resolve([]);
  }

  ndidsByEmail(text: string, limit: number): Promise<string[]> {
    return text.trim().length >= 3 ? this.users.ndidsByEmail(text.trim(), limit) : Promise.resolve([]);
  }

  async findOwnerByNdid(ndid: string): Promise<UserRecord | null> {
    const doc = ndid.trim() ? await this.users.findOldestAdminOfTenant(ndid.trim()) : null;
    return doc ? UserMapper.toRecord(doc) : null;
  }

  /**
   * A new account owner (self sign-up or first Google login): a new tenant id (ndid),
   * full access, written in the same shape nexon writes, so nexon can read the account.
   */
  async createOwner(input: CreateOwnerInput): Promise<UserRecord> {
    const doc = await this.users.create({
      emailId: input.email,
      ndid: randomUUID(),
      phone: input.phone ?? null,
      displayName: input.name,
      userName: input.name,
      accesskey: input.legacyPasswordHash,
      role: OWNER_ROLE,
      isAdmin: true,
      isActive: true,
      ...(input.googleId ? { google_id: input.googleId } : {}),
      accessScope: { ...FULL_ACCESS_SCOPE },
      assigned_location: [],
      createdAt: UsersService.pythonTimestamp(new Date()),
      onboarding: false,
    });
    return UserMapper.toRecord(doc);
  }

  async linkGoogleAccount(id: string, googleId: string): Promise<void> {
    await this.users.setGoogleId(id, googleId);
  }

  getLegacyPasswordHash(id: string): Promise<string | null> {
    return this.users.getAccesskey(id);
  }

  async setLegacyPasswordHash(id: string, hash: string): Promise<void> {
    await this.users.setAccesskey(id, hash);
  }

  /** Same text format as Python's str(datetime.now()), which nexon stores in createdAt. */
  private static pythonTimestamp(date: Date): string {
    return `${date.toISOString().replace("T", " ").slice(0, 23)}000`;
  }
}
