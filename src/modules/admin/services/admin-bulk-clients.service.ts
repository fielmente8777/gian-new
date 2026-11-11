import { AppError } from "../../../shared/errors/app-error.js";
import type { ClientTrashPort, TrashedClient } from "../../client-archive/index.js";
import type { AdminPermission } from "../constants/admin-permissions.js";
import {
  AdminPermissionDeniedError,
  BulkConfirmationError,
  ClientNotInTrashError,
  SubscriptionNotFoundError,
} from "../errors/admin.errors.js";
import type { AdminRecord } from "../types/admin.types.js";
import type { AdminAuditService } from "./admin-audit.service.js";
import type { AdminClientsService } from "./admin-clients.service.js";
import { AdminPermissions } from "./admin-permissions.service.js";
import type { AdminSubscriptionsService } from "./admin-subscriptions.service.js";

export const BULK_CLIENT_ACTIONS = ["pause", "resume", "trash", "restore", "delete"] as const;
export type BulkClientAction = (typeof BULK_CLIENT_ACTIONS)[number];

/** Who may run each action. Permanent delete stays super-admin only. */
const NEEDS: Record<BulkClientAction, AdminPermission> = {
  pause: "subscriptions.manage",
  resume: "subscriptions.manage",
  trash: "clients.trash",
  restore: "clients.trash",
  delete: "clients.delete",
};

export interface BulkClientRequest {
  action: BulkClientAction;
  ndids: string[];
  reason: string | null;
  /** permanent delete only: must be `DELETE <number of clients>`, e.g. "DELETE 3" */
  confirm: string | null;
}

export interface BulkClientResult {
  ndid: string;
  hotelName: string | null;
  ok: boolean;
  /** e.g. "already in the trash"; set when nothing needed doing */
  note: string | null;
  /** the error code when it failed, e.g. CLIENT_NOT_FOUND */
  error: string | null;
  message: string | null;
}

const TRASH_REASON = "Moved to the trash";

/**
 * The client list's bulk buttons: pause, resume, move to the trash, restore, delete forever.
 * Each client goes through the same service (and so the same scope checks and audit entries)
 * as its own page, one at a time; one failure never stops the rest, and every client gets a
 * line in the answer.
 *
 * The trash is a temporary delete: the client disappears from every list and its paid time
 * is paused (so services stop and no day is lost), but nothing is deleted. Restore resumes
 * the time if the trash paused it. Delete forever is the archive-then-delete of the client page.
 */
export class AdminBulkClientsService {
  constructor(
    private readonly clients: AdminClientsService,
    private readonly subscriptions: AdminSubscriptionsService,
    private readonly trash: ClientTrashPort,
    private readonly audit: AdminAuditService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(
    admin: AdminRecord,
    request: BulkClientRequest,
    ip?: string,
  ): Promise<{ results: BulkClientResult[]; done: number; failed: number }> {
    if (!AdminPermissions.has(admin, NEEDS[request.action]))
      throw new AdminPermissionDeniedError(NEEDS[request.action]);
    const ndids = [...new Set(request.ndids)];
    if (request.action === "delete" && request.confirm?.trim().toUpperCase() !== `DELETE ${ndids.length}`) {
      throw new BulkConfirmationError(ndids.length);
    }

    const results: BulkClientResult[] = [];
    for (const ndid of ndids) results.push(await this.one(admin, request, ndid, ip));
    const done = results.filter((r) => r.ok).length;
    return { results, done, failed: results.length - done };
  }

  /** The trash, newest first, within the person's properties. */
  async trashed(admin: AdminRecord): Promise<TrashedClient[]> {
    const scope = AdminPermissions.propertyScope(admin);
    return (await this.trash.list()).filter((t) => !scope || scope.has(t.ndid));
  }

  private async one(
    admin: AdminRecord,
    request: BulkClientRequest,
    ndid: string,
    ip?: string,
  ): Promise<BulkClientResult> {
    let hotelName: string | null = null;
    try {
      // also the scope check: a client outside the person's properties answers CLIENT_NOT_FOUND
      hotelName = (await this.clients.get(admin, ndid)).profile.hotelName;
      const note = await this.apply(admin, request, ndid, hotelName, ip);
      return { ndid, hotelName, ok: true, note, error: null, message: null };
    } catch (err) {
      const known = err instanceof AppError;
      return {
        ndid,
        hotelName,
        ok: false,
        note: null,
        error: known ? err.code : "FAILED",
        message: known ? err.message : "Something went wrong for this client",
      };
    }
  }

  /** Does the action; returns a note when there was nothing to do. */
  private async apply(
    admin: AdminRecord,
    { action, reason }: BulkClientRequest,
    ndid: string,
    hotelName: string | null,
    ip?: string,
  ): Promise<string | null> {
    switch (action) {
      case "pause": {
        const view = await this.subscriptions.pause(admin, ndid, reason, ip);
        return view.subscription.staffStop?.kind === "paused" ? null : "already stopped";
      }
      case "resume":
        await this.subscriptions.resume(admin, ndid, ip);
        return null;
      case "trash":
        return this.moveToTrash(admin, ndid, hotelName, reason, ip);
      case "restore":
        return this.restore(admin, ndid, ip);
      case "delete": {
        // the bulk confirmation stands in for typing each hotel's name
        await this.clients.delete(admin, ndid, hotelName?.trim() || ndid, reason, ip);
        await this.trash.remove(ndid);
        return null;
      }
    }
  }

  private async moveToTrash(
    admin: AdminRecord,
    ndid: string,
    hotelName: string | null,
    reason: string | null,
    ip?: string,
  ): Promise<string | null> {
    if (await this.trash.find(ndid)) return "already in the trash";
    let pausedSubscription = false;
    try {
      const before = await this.subscriptions.get(admin, ndid);
      if (!before.subscription.staffStop) {
        await this.subscriptions.pause(admin, ndid, reason ?? TRASH_REASON, ip);
        pausedSubscription = true;
      }
    } catch (err) {
      // a client with no subscription can still go to the trash
      if (!(err instanceof SubscriptionNotFoundError)) throw err;
    }
    await this.trash.add({ ndid, hotelName, by: admin.email, reason, trashedAt: this.now(), pausedSubscription });
    await this.audit.record({
      action: "client.trashed",
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: ndid,
      details: { hotelName, pausedSubscription, ...(reason ? { reason } : {}) },
      ip,
    });
    return null;
  }

  private async restore(admin: AdminRecord, ndid: string, ip?: string): Promise<string | null> {
    const entry = await this.trash.remove(ndid);
    if (!entry) throw new ClientNotInTrashError();
    let resumed = false;
    if (entry.pausedSubscription) {
      try {
        const view = await this.subscriptions.get(admin, ndid);
        // only undo our own pause; a stop staff set later on purpose stays
        if (view.subscription.staffStop?.kind === "paused") {
          await this.subscriptions.resume(admin, ndid, ip);
          resumed = true;
        }
      } catch (err) {
        if (!(err instanceof SubscriptionNotFoundError)) throw err;
      }
    }
    await this.audit.record({
      action: "client.restored",
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: ndid,
      details: { hotelName: entry.hotelName, resumedSubscription: resumed },
      ip,
    });
    return entry.pausedSubscription && !resumed ? "restored; its subscription stays stopped" : null;
  }
}
