import type {
  ReminderLogEntry,
  ReminderSettings,
  ReminderSettingsInput,
  RenewalReminderService,
  UpcomingReminder,
} from "../../renewal-reminders/index.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AdminRecord, AuditChanges } from "../types/admin.types.js";
import type { AdminAuditService } from "./admin-audit.service.js";
import { AdminPermissions } from "./admin-permissions.service.js";

export interface RemindersOverview {
  settings: ReminderSettings;
  /** the server has Eazotel's WhatsApp number and token */
  whatsappReady: boolean;
  /** emails really go out (false on a development machine with no mail server) */
  emailReady: boolean;
}

export interface ManualReminderResult {
  ndid: string;
  ok: boolean;
  entry: ReminderLogEntry | null;
  error: string | null;
  message: string | null;
}

/**
 * Billing → Reminders in the admin console: the schedule, who gets what in the coming days,
 * what was sent, and "send a reminder now" for one client or a selection. Admins with assigned
 * properties see and remind only those clients.
 */
export class AdminRemindersService {
  constructor(
    private readonly reminders: RenewalReminderService,
    private readonly audit: AdminAuditService,
    private readonly emailReady: boolean,
  ) {}

  async overview(): Promise<RemindersOverview> {
    return {
      settings: await this.reminders.settings(),
      whatsappReady: this.reminders.whatsappReady,
      emailReady: this.emailReady,
    };
  }

  async saveSettings(admin: AdminRecord, input: ReminderSettingsInput, ip?: string): Promise<RemindersOverview> {
    const before = await this.reminders.settings();
    const after = await this.reminders.saveSettings(input, admin.email);
    const changes: AuditChanges = {};
    for (const key of Object.keys(input) as (keyof ReminderSettingsInput)[]) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        changes[key] = { from: before[key], to: after[key] };
    }
    if (Object.keys(changes).length) {
      await this.audit.record({
        action: "reminders.settings_updated",
        actorId: admin.id,
        actorEmail: admin.email,
        changes,
        ip,
      });
    }
    return this.overview();
  }

  async upcoming(admin: AdminRecord, days: number): Promise<UpcomingReminder[]> {
    const scope = AdminPermissions.propertyScope(admin);
    return (await this.reminders.upcoming(days)).filter((r) => !scope || scope.has(r.ndid));
  }

  async history(
    admin: AdminRecord,
    query: { limit: number; ndid?: string; before?: Date },
  ): Promise<ReminderLogEntry[]> {
    const scope = AdminPermissions.propertyScope(admin);
    if (scope && query.ndid && !scope.has(query.ndid)) return [];
    // scoped admins: read more and keep theirs, so a page isn't empty just because others' came first
    const rows = await this.reminders.history(scope ? { ...query, limit: Math.min(query.limit * 10, 1000) } : query);
    return (scope ? rows.filter((r) => scope.has(r.ndid)) : rows).slice(0, query.limit);
  }

  /** Sends now, one client after the other; a failure for one never stops the rest. */
  async sendNow(
    admin: AdminRecord,
    ndids: string[],
    ip?: string,
  ): Promise<{ results: ManualReminderResult[]; sent: number }> {
    const scope = AdminPermissions.propertyScope(admin);
    const results: ManualReminderResult[] = [];
    for (const ndid of [...new Set(ndids)]) {
      if (scope && !scope.has(ndid)) {
        results.push({
          ndid,
          ok: false,
          entry: null,
          error: "CLIENT_NOT_FOUND",
          message: "This client does not exist",
        });
        continue;
      }
      try {
        const entry = await this.reminders.sendNow(ndid, admin.email);
        const ok = entry.email.status === "sent" || entry.whatsapp.status === "sent";
        results.push({
          ndid,
          ok,
          entry,
          error: ok ? null : "NOT_DELIVERED",
          message: ok ? null : [entry.email.note, entry.whatsapp.note].filter(Boolean).join("; "),
        });
        await this.audit.record({
          action: "reminders.sent",
          actorId: admin.id,
          actorEmail: admin.email,
          targetId: ndid,
          details: { email: entry.email.status, whatsapp: entry.whatsapp.status, offsetDays: entry.offsetDays },
          ip,
        });
      } catch (err) {
        results.push({
          ndid,
          ok: false,
          entry: null,
          error: err instanceof AppError ? err.code : "FAILED",
          message: err instanceof AppError ? err.message : "Something went wrong for this client",
        });
      }
    }
    return { results, sent: results.filter((r) => r.ok).length };
  }
}
