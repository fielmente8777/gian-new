import type { AdminAdvancedPermission } from "../constants/admin-permissions.js";

export type AdminRole = "super_admin" | "admin";
export type AdminStatus = "active" | "disabled";

/** One property given to an admin. Several admins may hold the same property, with no limit. */
export interface AssignedProperty {
  ndid: string;
  hid: string;
}

/** A member of the Eazotel team (collection admin_users). Never a hotel account. */
export interface AdminRecord {
  id: string;
  email: string;
  name: string | null;
  role: AdminRole;
  status: AdminStatus;
  googleId: string | null;
  advancedPermissions: AdminAdvancedPermission[];
  assignedProperties: AssignedProperty[];
  lastLoginAt: Date | null;
}

export interface NewAdmin {
  email: string;
  name: string | null;
  role: AdminRole;
}

/** Someone a super admin adds from the team screen. */
export interface NewTeamMember extends NewAdmin {
  advancedPermissions: AdminAdvancedPermission[];
  assignedProperties: AssignedProperty[];
}

/** What a super admin can change on a staff member. The email never changes. */
export type TeamMemberChanges = Partial<
  Pick<AdminRecord, "name" | "role" | "status" | "advancedPermissions" | "assignedProperties">
>;

export const ADMIN_AUDIT_ACTIONS = [
  "login.denied",
  "login.code_sent",
  "login.success",
  "team.member_added",
  "team.member_updated",
  "team.invite_sent",
  "team.saved_by_script",
  "client.updated",
  "client.account_opened",
  "client.deleted",
  "client.trashed",
  "client.restored",
  "client.service_changed",
  "client.notifications_changed",
  "client.team_phone_changed",
  "client.owner_phone_filled",
  "subscription.paused",
  "subscription.resumed",
  "subscription.renewed",
  "subscription.expired",
  "subscription.plan_changed",
  "subscription.apps_changed",
  "billing.plan_created",
  "billing.plan_updated",
  "billing.app_created",
  "billing.app_updated",
  "billing.settings_updated",
  "billing.offer_created",
  "billing.offer_updated",
  "billing.invoice_created",
  "billing.invoice_emailed",
  "meta_page.linked",
  "meta_page.unlinked",
  "meta_pages.synced",
  "reminders.settings_updated",
  "reminders.sent",
  "billing.payment_provider_changed",
  "zoho.connect_started",
  "zoho.disconnected",
  "zoho.tax_changed",
  "zoho.customer_linked",
  "zoho.customer_unlinked",
  "zoho.invoice_created",
  "zoho.invoice_applied",
  "zoho.invoice_ignored",
  "credits.granted",
  "credits.deducted",
  "credits.wallet_suspended",
  "credits.wallet_resumed",
  "credits.bulk_granted",
  "credits.pricing_changed",
  "credits.package_changed",
  "credits.settings_changed",
  "credits.openai_topup_added",
  "credits.openai_topup_edited",
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

/** Old and new value of each field a staff action changed. */
export type AuditChanges = Record<string, { from: unknown; to: unknown }>;

/** One line of the audit log (collection admin_audit_logs). Lines are only ever added. */
export interface AdminAuditEntry {
  id: string;
  action: AdminAuditAction;
  /** Null when nobody is signed in yet, such as a refused login. */
  actorId: string | null;
  actorEmail: string | null;
  targetId: string | null;
  targetEmail: string | null;
  changes: AuditChanges | null;
  /** Anything else worth keeping, such as why a login was refused. */
  details: Record<string, unknown> | null;
  ip: string | null;
  at: Date;
}

export type NewAdminAuditEntry = Pick<AdminAuditEntry, "action"> &
  Partial<Omit<AdminAuditEntry, "id" | "action" | "at" | "ip">> & { ip?: string | null | undefined };

export interface AdminAuditQuery {
  limit: number;
  /** Id of the last entry already shown; returns older ones. */
  before?: string;
  action?: AdminAuditAction;
  /** Entries where this person acted or was acted on. */
  email?: string;
}

export interface AdminAuditPage {
  items: AdminAuditEntry[];
  /** Pass as `before` for the next page. Null when there is nothing older. */
  nextCursor: string | null;
}

/** One login waiting for its email code. Only a hash of the code is kept. */
export interface OtpChallenge {
  id: string;
  adminId: string;
  /** the Google account that started this login; linked to the admin once the code is right */
  googleSub: string;
  codeHash: string;
  attempts: number;
  sends: number;
  lastSentAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export type NewOtpChallenge = Omit<OtpChallenge, "attempts" | "sends" | "consumedAt">;

export interface OtpCodeReplacement {
  codeHash: string;
  lastSentAt: Date;
  expiresAt: Date;
}

// ── ports: implemented by the mongoose repositories, faked in tests ──────────

export interface AdminUserStore {
  findById(id: string): Promise<AdminRecord | null>;
  findByEmail(email: string): Promise<AdminRecord | null>;
  recordLogin(id: string, googleId: string, at: Date): Promise<void>;
  list(): Promise<AdminRecord[]>;
  /** Null when the email is already on the team. */
  create(member: NewTeamMember): Promise<AdminRecord | null>;
  update(id: string, changes: TeamMemberChanges): Promise<AdminRecord | null>;
  countActiveSuperAdmins(): Promise<number>;
}

export interface AdminAuditStore {
  create(entry: NewAdminAuditEntry, at: Date): Promise<void>;
  list(query: AdminAuditQuery): Promise<AdminAuditPage>;
}

export interface OtpChallengeStore {
  create(challenge: NewOtpChallenge): Promise<void>;
  find(id: string): Promise<OtpChallenge | null>;
  /** Atomically counts one attempt. False when `maxAttempts` were already used. */
  recordAttempt(id: string, maxAttempts: number): Promise<boolean>;
  /** Atomically marks the challenge used. False when it was already used, so a code works once. */
  consume(id: string, at: Date): Promise<boolean>;
  /** Atomically swaps in a new code, unless it was last sent after `sentBefore` or `maxSends` is reached. */
  replaceCode(id: string, code: OtpCodeReplacement, sentBefore: Date, maxSends: number): Promise<boolean>;
  delete(id: string): Promise<void>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by AdminAuthenticateMiddleware, read fresh from the database on every request. */
      admin?: AdminRecord;
    }
  }
}
