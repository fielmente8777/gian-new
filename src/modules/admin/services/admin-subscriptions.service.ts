import type { EffectiveServices } from "../../client-services/index.js";
import {
  SubscriptionRule,
  type AppAssignment,
  type AppRecord,
  type PlanRecord,
  type SubscriptionPage,
  type SubscriptionRecord,
  type SubscriptionSearch,
  type SubscriptionsPort,
  type SubscriptionState,
} from "../../subscriptions/index.js";
import {
  AppNotFoundError,
  ClientNotFoundError,
  PlanNotFoundError,
  SubscriptionNotFoundError,
} from "../errors/admin.errors.js";
import type { AdminAuditAction, AdminRecord, AuditChanges } from "../types/admin.types.js";
import type { AdminAuditService } from "./admin-audit.service.js";
import type { ServiceControl } from "./admin-clients.service.js";
import { AdminPermissions } from "./admin-permissions.service.js";

/** A subscription as the console shows it, with what actually runs for the client. */
export interface SubscriptionView {
  subscription: SubscriptionRecord;
  state: SubscriptionState;
  services: EffectiveServices;
  /** leads the hotel hasn't been told about yet */
  heldLeads: number;
  /** leads in the catch-up email this action sent */
  emailed?: number;
}

export type SubscriptionListQuery = Omit<SubscriptionSearch, "ndids">;

/** How far to renew: a number of months from today (or from the current end, if later), or an exact date. */
export type RenewTerm = { months: number } | { until: Date };

/**
 * Staff manage hotel subscriptions here: pause, resume, renew, expire, change plan. Every
 * change is logged, and the client's services follow at once:
 *
 * - pause / expire: `endDate` becomes now, so the hotel dashboard shows its renew page; the
 *   chatbot hides; new leads are kept but the hotel isn't told.
 * - resume / renew: the dashboard opens again, the chatbot comes back, held leads move into
 *   the dashboard and the hotel gets ONE email listing them.
 *
 * Like clients, a subscription outside an admin's properties answers "not found".
 */
export class AdminSubscriptionsService {
  constructor(
    private readonly subscriptions: SubscriptionsPort,
    private readonly control: ServiceControl,
    private readonly audit: AdminAuditService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  plans(): Promise<PlanRecord[]> {
    return this.subscriptions.plans();
  }

  async list(admin: AdminRecord, query: SubscriptionListQuery): Promise<SubscriptionPage> {
    const scope = AdminPermissions.propertyScope(admin);
    if (scope?.size === 0)
      return { items: [], total: 0, counts: { all: 0, active: 0, ending: 0, ended: 0, stopped: 0 } };
    return this.subscriptions.list({ ...query, ...(scope ? { ndids: [...scope.keys()] } : {}) });
  }

  async get(admin: AdminRecord, ndid: string): Promise<SubscriptionView> {
    return this.view(await this.findVisible(admin, ndid));
  }

  /** `endApps`: also end every app now; resume then gives them the subscription's new end. */
  async pause(
    admin: AdminRecord,
    ndid: string,
    reason: string | null,
    ip?: string,
    endApps = false,
  ): Promise<SubscriptionView> {
    const before = await this.findVisible(admin, ndid);
    if (before.staffStop) return this.view(before);
    const endsApps = endApps && before.apps.length > 0;
    let after = await this.subscriptions.pause(ndid, admin.email, reason, this.now(), endsApps);
    if (after && endsApps) after = await this.endAllApps(after);
    return this.finish(admin, "subscription.paused", before, after, ip, {
      reason,
      ...(endsApps ? { appsEnded: true } : {}),
    });
  }

  async resume(admin: AdminRecord, ndid: string, ip?: string): Promise<SubscriptionView> {
    const before = await this.findVisible(admin, ndid);
    if (before.staffStop?.kind !== "paused") return this.view(before);
    let after = await this.subscriptions.resume(ndid, this.now());
    if (after && before.staffStop.appsEnded && after.apps.length > 0) {
      const until = after.endDate;
      after = await this.subscriptions.setApps(
        ndid,
        after.apps.map((a) => ({ appId: a.appId, endDate: until, isTrial: a.isTrial })),
        this.now(),
      );
    }
    return this.finish(admin, "subscription.resumed", before, after, ip);
  }

  /** Every app ends now (kept on the subscription, so renew or resume can extend them). */
  private endAllApps(subscription: SubscriptionRecord): Promise<SubscriptionRecord | null> {
    const now = this.now();
    return this.subscriptions.setApps(
      subscription.ndid,
      subscription.apps.map((a) => ({ appId: a.appId, endDate: now, isTrial: a.isTrial })),
      now,
    );
  }

  async renew(
    admin: AdminRecord,
    ndid: string,
    term: RenewTerm,
    planId: string | null,
    note: string | null,
    ip?: string,
    /** also move every app the hotel has to the new end, as paid */
    extendApps = true,
  ): Promise<SubscriptionView> {
    const before = await this.findVisible(admin, ndid);
    if (planId && !(await this.subscriptions.plans()).some((p) => p.id === planId)) throw new PlanNotFoundError();
    const until =
      "until" in term ? term.until : AdminSubscriptionsService.addMonths(this.renewFrom(before), term.months);
    let after = await this.subscriptions.renew(ndid, until, planId, this.now());
    if (after && extendApps && after.apps.length > 0) {
      const apps = after.apps.map((a) => ({ appId: a.appId, endDate: until, isTrial: false }));
      after = await this.subscriptions.setApps(ndid, apps, this.now());
    }
    return this.finish(admin, "subscription.renewed", before, after, ip, {
      note,
      ...(extendApps && before.apps.length ? { appsExtended: before.apps.length } : {}),
    });
  }

  appCatalogue(): Promise<AppRecord[]> {
    return this.subscriptions.appCatalogue();
  }

  /**
   * Sets exactly which apps the hotel has and until when. Unlisted apps are removed and turned
   * off in its dashboard (appAccess); listed ones are turned on.
   */
  async setApps(admin: AdminRecord, ndid: string, apps: AppAssignment[], ip?: string): Promise<SubscriptionView> {
    const before = await this.findVisible(admin, ndid);
    const known = new Set((await this.subscriptions.appCatalogue()).map((a) => a.id));
    if (apps.some((a) => !known.has(a.appId))) throw new AppNotFoundError();
    const after = await this.subscriptions.setApps(ndid, apps, this.now());
    return this.finish(admin, "subscription.apps_changed", before, after, ip);
  }

  /** `endApps`: also end every app now; renew extends them again. */
  async expire(
    admin: AdminRecord,
    ndid: string,
    reason: string | null,
    ip?: string,
    endApps = false,
  ): Promise<SubscriptionView> {
    const before = await this.findVisible(admin, ndid);
    if (before.staffStop?.kind === "expired") return this.view(before);
    const endsApps = endApps && before.apps.length > 0;
    let after = await this.subscriptions.expire(ndid, admin.email, reason, this.now(), endsApps);
    if (after && endsApps) after = await this.endAllApps(after);
    return this.finish(admin, "subscription.expired", before, after, ip, {
      reason,
      ...(endsApps ? { appsEnded: true } : {}),
    });
  }

  async changePlan(admin: AdminRecord, ndid: string, planId: string, ip?: string): Promise<SubscriptionView> {
    const before = await this.findVisible(admin, ndid);
    if (!(await this.subscriptions.plans()).some((p) => p.id === planId)) throw new PlanNotFoundError();
    if (before.plan?.id === planId) return this.view(before);
    const after = await this.subscriptions.changePlan(ndid, planId, this.now());
    return this.finish(admin, "subscription.plan_changed", before, after, ip);
  }

  /** Renewing adds to what's left: from the current end if it's still ahead, else from today. A pause gives its time back first. */
  private renewFrom(subscription: SubscriptionRecord): Date {
    const now = this.now();
    if (subscription.staffStop?.kind === "paused") {
      return new Date(now.getTime() + (subscription.staffStop.remainingMs ?? 0));
    }
    if (subscription.staffStop) return now;
    return subscription.endDate > now ? subscription.endDate : now;
  }

  private async finish(
    admin: AdminRecord,
    action: AdminAuditAction,
    before: SubscriptionRecord,
    after: SubscriptionRecord | null,
    ip: string | undefined,
    details: Record<string, unknown> = {},
  ): Promise<SubscriptionView> {
    if (!after) throw new SubscriptionNotFoundError();
    const applied = await this.control.enforcer.apply(after.ndid);
    await this.audit.record({
      action,
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: after.ndid,
      targetEmail: null,
      changes: AdminSubscriptionsService.describe(before, after),
      details: {
        hotelName: after.hotelName,
        ...Object.fromEntries(Object.entries(details).filter(([, v]) => v !== null && v !== undefined)),
        ...(applied.released?.leads ? { releasedLeads: applied.released.leads } : {}),
        ...(applied.emailed ? { emailedLeads: applied.emailed } : {}),
      },
      ip,
    });
    return { ...(await this.view(after)), ...(applied.emailed ? { emailed: applied.emailed } : {}) };
  }

  private async view(subscription: SubscriptionRecord): Promise<SubscriptionView> {
    const [services, heldLeads] = await Promise.all([
      this.control.enforcer.effective(subscription.ndid),
      this.control.store.countPendingAlerts(subscription.ndid),
    ]);
    return { subscription, state: SubscriptionRule.state(subscription, this.now()), services, heldLeads };
  }

  private async findVisible(admin: AdminRecord, ndid: string): Promise<SubscriptionRecord> {
    const scope = AdminPermissions.propertyScope(admin);
    if (scope && !scope.has(ndid)) throw new ClientNotFoundError();
    const subscription = await this.subscriptions.findByNdid(ndid);
    if (!subscription) throw new SubscriptionNotFoundError();
    return subscription;
  }

  private static describe(before: SubscriptionRecord, after: SubscriptionRecord): AuditChanges {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const changes: AuditChanges = {};
    if (day(before.endDate) !== day(after.endDate))
      changes.endDate = { from: day(before.endDate), to: day(after.endDate) };
    if (before.status !== after.status) changes.status = { from: before.status, to: after.status };
    if (before.plan?.id !== after.plan?.id)
      changes.plan = { from: before.plan?.name ?? null, to: after.plan?.name ?? null };
    const appsOf = (s: SubscriptionRecord) =>
      s.apps
        .map((a) => `${a.name ?? a.appId} until ${day(a.endDate)}${a.isTrial ? " (trial)" : ""}`)
        .sort()
        .join(", ") || "none";
    if (appsOf(before) !== appsOf(after)) changes.apps = { from: appsOf(before), to: appsOf(after) };
    const stop = (s: SubscriptionRecord) => (s.staffStop ? `stopped (${s.staffStop.kind})` : "running");
    if (stop(before) !== stop(after)) changes.services = { from: stop(before), to: stop(after) };
    return changes;
  }

  static addMonths(from: Date, months: number): Date {
    const date = new Date(from);
    const day = date.getUTCDate();
    date.setUTCMonth(date.getUTCMonth() + months);
    // 31 Jan + 1 month = 28/29 Feb, not 3 Mar
    if (date.getUTCDate() < day) date.setUTCDate(0);
    return date;
  }
}
