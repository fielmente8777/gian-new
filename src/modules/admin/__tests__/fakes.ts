import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { MailMessage, Mailer } from "../../../integrations/mail/mailer.js";
import type {
  AdminAuditEntry,
  AdminAuditQuery,
  AdminAuditStore,
  AdminRecord,
  AdminUserStore,
  NewAdminAuditEntry,
  NewOtpChallenge,
  NewTeamMember,
  OtpChallenge,
  OtpChallengeStore,
  OtpCodeReplacement,
  TeamMemberChanges,
} from "../types/admin.types.js";

// In-memory stand-ins for the Mongo stores and the mail server.

export class InMemoryAdmins implements AdminUserStore {
  readonly rows = new Map<string, AdminRecord>();

  add(partial: Partial<AdminRecord> & { email: string }): AdminRecord {
    const admin: AdminRecord = {
      id: randomUUID().replace(/-/g, "").slice(0, 24),
      name: "Staff",
      role: "admin",
      status: "active",
      googleId: null,
      advancedPermissions: [],
      assignedProperties: [],
      lastLoginAt: null,
      ...partial,
    };
    this.rows.set(admin.id, admin);
    return admin;
  }

  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }

  async findByEmail(email: string) {
    return [...this.rows.values()].find((a) => a.email === email.trim().toLowerCase()) ?? null;
  }

  async recordLogin(id: string, googleId: string, at: Date) {
    const admin = this.rows.get(id);
    if (admin) this.rows.set(id, { ...admin, googleId, lastLoginAt: at });
  }

  async list() {
    return [...this.rows.values()].sort((a, b) => a.email.localeCompare(b.email));
  }

  async create(member: NewTeamMember) {
    if (await this.findByEmail(member.email)) return null;
    return this.add(member);
  }

  async update(id: string, changes: TeamMemberChanges) {
    const admin = this.rows.get(id);
    if (!admin) return null;
    const updated = { ...admin, ...changes };
    this.rows.set(id, updated);
    return updated;
  }

  async countActiveSuperAdmins() {
    return [...this.rows.values()].filter((a) => a.role === "super_admin" && a.status === "active").length;
  }
}

export class InMemoryChallenges implements OtpChallengeStore {
  readonly rows = new Map<string, OtpChallenge>();

  async create(challenge: NewOtpChallenge) {
    this.rows.set(challenge.id, { ...challenge, attempts: 0, sends: 1, consumedAt: null });
  }

  async find(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async recordAttempt(id: string, maxAttempts: number) {
    const row = this.rows.get(id);
    if (!row || row.consumedAt || row.attempts >= maxAttempts) return false;
    row.attempts += 1;
    return true;
  }

  async consume(id: string, at: Date) {
    const row = this.rows.get(id);
    if (!row || row.consumedAt) return false;
    row.consumedAt = at;
    return true;
  }

  async replaceCode(id: string, code: OtpCodeReplacement, sentBefore: Date, maxSends: number) {
    const row = this.rows.get(id);
    if (!row || row.consumedAt || row.lastSentAt > sentBefore || row.sends >= maxSends) return false;
    Object.assign(row, code);
    row.sends += 1;
    return true;
  }

  async delete(id: string) {
    this.rows.delete(id);
  }
}

export class FakeMailbox implements Mailer {
  readonly sent: MailMessage[] = [];
  readonly delivers = true;
  failing = false;

  async send(message: MailMessage) {
    if (this.failing) throw new Error("smtp down");
    this.sent.push(message);
  }

  /** The code in the most recent email. */
  get lastCode(): string {
    const code = /\b(\d{6})\b/.exec(this.sent.at(-1)?.text ?? "")?.[1];
    assert.ok(code, "expected an email with a code");
    return code;
  }
}

export class InMemoryAuditLog implements AdminAuditStore {
  readonly rows: AdminAuditEntry[] = [];
  failing = false;
  private sequence = 0;

  async create(entry: NewAdminAuditEntry, at: Date) {
    if (this.failing) throw new Error("database down");
    this.sequence += 1;
    this.rows.push({
      id: this.sequence.toString(16).padStart(24, "0"),
      actorId: null,
      actorEmail: null,
      targetId: null,
      targetEmail: null,
      changes: null,
      details: null,
      ...entry,
      ip: entry.ip ?? null,
      at,
    });
  }

  async list({ limit, before, action, email }: AdminAuditQuery) {
    const matching = [...this.rows]
      .reverse()
      .filter((row) => !before || row.id < before)
      .filter((row) => !action || row.action === action)
      .filter((row) => !email || row.actorEmail === email || row.targetEmail === email);
    const items = matching.slice(0, limit);
    return { items, nextCursor: matching.length > limit ? (items.at(-1)?.id ?? null) : null };
  }
}

/** Stands in for the auth module's ClientAccountTokens. */
export class FakeClientAccounts {
  readonly issued: string[] = [];
  failing = false;

  async issue(accountEmail: string) {
    if (this.failing) throw new Error("no secret");
    this.issued.push(accountEmail);
    return { token: `client-token-for:${accountEmail}`, expiresAt: new Date(Date.now() + 3_600_000) };
  }
}
