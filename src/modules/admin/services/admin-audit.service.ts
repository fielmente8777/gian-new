import type { Logger } from "../../../shared/logger/logger.js";
import type {
  AdminAuditAction,
  AdminAuditPage,
  AdminAuditQuery,
  AdminAuditStore,
  NewAdminAuditEntry,
} from "../types/admin.types.js";

const WARNING_ACTIONS: ReadonlySet<AdminAuditAction> = new Set(["login.denied"]);

/**
 * Writes the audit log. Every entry also goes to the server logs, so if the database write
 * fails the record still exists there, and the action that already happened is not reported
 * to the staff member as failed.
 */
export class AdminAuditService {
  constructor(
    private readonly store: AdminAuditStore,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entry: NewAdminAuditEntry): Promise<void> {
    const level = WARNING_ACTIONS.has(entry.action) ? "warn" : "info";
    this.logger[level]({ audit: entry.action, ...entry }, `admin audit: ${entry.action}`);
    try {
      await this.store.create(entry, this.now());
    } catch (err) {
      this.logger.error({ err, audit: entry.action }, "could not save this entry to the audit log");
    }
  }

  list(query: AdminAuditQuery): Promise<AdminAuditPage> {
    return this.store.list(query);
  }
}
