import {
  ENDING_SOON_DAYS,
  type AppAssignment,
  type AppRecord,
  type PlanRecord,
  type SubscriptionRecord,
  type SubscriptionSearch,
  type SubscriptionsPort,
  type SubscriptionState,
} from "../types/subscriptions.types.js";

export const PLANS: PlanRecord[] = [
  { id: "aaaaaaaaaaaaaaaaaaaaaaa1", name: "TRIAL", price: 0 },
  { id: "aaaaaaaaaaaaaaaaaaaaaaa2", name: "BASIC", price: 499 },
  { id: "aaaaaaaaaaaaaaaaaaaaaaa3", name: "PRO", price: 999 },
];

const DAY = 86_400_000;

export const APPS: AppRecord[] = [
  { id: "bbbbbbbbbbbbbbbbbbbbbbb1", name: "Eazbot", code: "eazbot", price: 500, isActive: true },
  { id: "bbbbbbbbbbbbbbbbbbbbbbb2", name: "Meta Leads", code: "meta", price: 500, isActive: true },
  { id: "bbbbbbbbbbbbbbbbbbbbbbb3", name: "WhatsApp Chat", code: "whatsapp", price: 1000, isActive: true },
];

/** In-memory subscriptions, with the same rules as SubscriptionRepository. */
export class InMemorySubscriptions implements SubscriptionsPort {
  readonly rows = new Map<string, SubscriptionRecord>();

  add(ndid: string, hotelName: string, daysLeft: number, planName = "BASIC"): SubscriptionRecord {
    const now = Date.now();
    const record: SubscriptionRecord = {
      ndid,
      hotelName,
      plan: PLANS.find((p) => p.name === planName) ?? null,
      status: daysLeft > 0 ? "ACTIVE" : "EXPIRED",
      startDate: new Date(now - 30 * DAY),
      endDate: new Date(now + daysLeft * DAY),
      autoRenew: false,
      staffStop: null,
      apps: [],
      appAccess: Object.fromEntries(APPS.map((a) => [a.code, true])),
      updatedAt: null,
    };
    this.rows.set(ndid, record);
    return record;
  }

  async plans() {
    return PLANS;
  }

  async appCatalogue() {
    return APPS;
  }

  async setApps(ndid: string, apps: AppAssignment[], now: Date) {
    const r = this.rows.get(ndid);
    if (!r) return null;
    const chosen = new Set(apps.map((a) => a.appId));
    return this.save({
      ...r,
      apps: apps.map((a) => {
        const app = APPS.find((c) => c.id === a.appId);
        const before = r.apps.find((x) => x.appId === a.appId);
        return {
          appId: a.appId,
          name: app?.name ?? null,
          code: app?.code ?? null,
          isTrial: a.isTrial,
          startDate: before?.startDate ?? now,
          endDate: a.endDate,
        };
      }),
      appAccess: { ...r.appAccess, ...Object.fromEntries(APPS.map((c) => [c.code, chosen.has(c.id)])) },
    });
  }

  async planExists(planId: string) {
    return PLANS.some((p) => p.id === planId);
  }

  async list({ page, pageSize, sort, order, state, ndids, search }: SubscriptionSearch) {
    const now = Date.now();
    const stateOf = (r: SubscriptionRecord): SubscriptionState =>
      r.staffStop
        ? "stopped"
        : r.endDate.getTime() <= now || r.status === "CANCELLED"
          ? "ended"
          : r.endDate.getTime() - now <= ENDING_SOON_DAYS * DAY
            ? "ending"
            : "active";
    const rank = ["active", "ending", "ended", "stopped"];
    const key = (r: SubscriptionRecord): string | number =>
      sort === "hotel"
        ? (r.hotelName ?? r.ndid).toLowerCase()
        : sort === "plan"
          ? (r.plan?.price ?? -1)
          : sort === "state"
            ? rank.indexOf(stateOf(r))
            : r.endDate.getTime();
    const scoped = [...this.rows.values()]
      .filter((r) => !ndids || ndids.includes(r.ndid))
      .filter((r) => !search || r.ndid === search || (r.hotelName ?? "").toLowerCase().includes(search.toLowerCase()))
      .map((r) => ({ ...r, state: stateOf(r) }));
    const counts = { all: scoped.length, active: 0, ending: 0, ended: 0, stopped: 0 };
    for (const r of scoped) counts[r.state] += 1;
    const matching = scoped
      .filter((r) => !state || r.state === state)
      .sort((a, b) => {
        const [x, y] = [key(a), key(b)];
        const c = x < y ? -1 : x > y ? 1 : a.ndid.localeCompare(b.ndid);
        return order === "desc" && x !== y ? -c : c;
      });
    return { items: matching.slice((page - 1) * pageSize, page * pageSize), total: matching.length, counts };
  }

  async findByNdid(ndid: string) {
    return this.rows.get(ndid) ?? null;
  }

  async pause(ndid: string, by: string, reason: string | null, now: Date, appsEnded = false) {
    const r = this.rows.get(ndid);
    if (!r) return null;
    if (r.staffStop) return r;
    const remainingMs = Math.max(0, r.endDate.getTime() - now.getTime());
    return this.save({
      ...r,
      endDate: now,
      staffStop: { kind: "paused", at: now, by, reason, remainingMs, appsEnded },
    });
  }

  async resume(ndid: string, now: Date) {
    const r = this.rows.get(ndid);
    if (!r) return null;
    if (r.staffStop?.kind !== "paused") return r;
    return this.save({ ...r, endDate: new Date(now.getTime() + (r.staffStop.remainingMs ?? 0)), staffStop: null });
  }

  async renew(ndid: string, until: Date, planId: string | null) {
    const r = this.rows.get(ndid);
    if (!r) return null;
    const plan = planId ? (PLANS.find((p) => p.id === planId) ?? r.plan) : r.plan;
    return this.save({ ...r, endDate: until, status: "ACTIVE", staffStop: null, plan });
  }

  async expire(ndid: string, by: string, reason: string | null, now: Date, appsEnded = false) {
    const r = this.rows.get(ndid);
    if (!r) return null;
    return this.save({
      ...r,
      endDate: now,
      status: "EXPIRED",
      staffStop: { kind: "expired", at: now, by, reason, remainingMs: null, appsEnded },
    });
  }

  async changePlan(ndid: string, planId: string) {
    const r = this.rows.get(ndid);
    if (!r) return null;
    return this.save({ ...r, plan: PLANS.find((p) => p.id === planId) ?? r.plan });
  }

  async stoppedNdids(followExpiry: boolean, now: Date) {
    return [...this.rows.values()]
      .filter((r) => r.staffStop || (followExpiry && (r.endDate <= now || r.status === "CANCELLED")))
      .map((r) => r.ndid);
  }

  private save(record: SubscriptionRecord) {
    this.rows.set(record.ndid, { ...record, updatedAt: new Date() });
    return this.rows.get(record.ndid)!;
  }
}
