/**
 * A hotel's subscription: gian's `subscriptions` collection (one per ndid), which the hotel
 * dashboard reads through Zucks_profile.subscriptionId. When `endDate` has passed, the hotel
 * dashboard sends the hotel to its plans page, so staff pausing or expiring a subscription
 * moves `endDate` to now.
 */
export interface PlanRecord {
  id: string;
  name: string;
  price: number;
}

/** An add-on app a hotel can have (gian's `apps` collection). */
export interface AppRecord {
  id: string;
  name: string;
  /** the subscription's `appAccess` key that unlocks it in the hotel dashboard */
  code: string;
  price: number;
  isActive: boolean;
}

/** One app on a subscription. Duplicates in the database are merged: latest end, earliest start. */
export interface SubscriptionApp {
  appId: string;
  name: string | null;
  code: string | null;
  isTrial: boolean;
  startDate: Date;
  endDate: Date;
}

/** What staff set for one app: it stays on the subscription until `endDate`. */
export interface AppAssignment {
  appId: string;
  endDate: Date;
  isTrial: boolean;
}

export type SubscriptionStatus = "ACTIVE" | "EXPIRED" | "CANCELLED" | "TRIAL";

/** Set while staff have stopped this client (pause or expire). Services stay off until renew or resume. */
export interface StaffStop {
  kind: "paused" | "expired";
  at: Date;
  by: string;
  reason: string | null;
  /** pause only: the time that was left, given back on resume */
  remainingMs: number | null;
  /** staff also ended every app; a resume gives them the subscription's new end */
  appsEnded?: boolean;
}

export interface SubscriptionRecord {
  ndid: string;
  hotelName: string | null;
  plan: PlanRecord | null;
  status: SubscriptionStatus;
  startDate: Date;
  endDate: Date;
  autoRenew: boolean;
  staffStop: StaffStop | null;
  /** one per app, merged */
  apps: SubscriptionApp[];
  /** what the hotel dashboard unlocks, by app code (and some older keys) */
  appAccess: Record<string, boolean>;
  updatedAt: Date | null;
}

/** Which subscriptions to list, by how they look today. */
export type SubscriptionState = "active" | "ending" | "ended" | "stopped";

export type SubscriptionSort = "hotel" | "plan" | "endDate" | "state";

export interface SubscriptionSearch {
  /** 1-based */
  page: number;
  pageSize: number;
  sort: SubscriptionSort;
  order: "asc" | "desc";
  state?: SubscriptionState;
  /** only these clients; undefined = all */
  ndids?: string[];
  /** never these clients (the ones in the admin console's trash) */
  excludeNdids?: string[];
  /** part of the hotel name, or an exact ndid */
  search?: string;
  /** with `search`: these clients match too (e.g. their login email matched) */
  orNdids?: string[];
}

/** How many subscriptions are in each state (search and scope applied, state filter not). */
export type SubscriptionCounts = Record<SubscriptionState | "all", number>;

export interface SubscriptionPage {
  items: (SubscriptionRecord & { state: SubscriptionState })[];
  /** matching the state filter too */
  total: number;
  counts: SubscriptionCounts;
}

export interface SubscriptionsPort {
  plans(): Promise<PlanRecord[]>;
  planExists(planId: string): Promise<boolean>;
  appCatalogue(): Promise<AppRecord[]>;
  /**
   * Replaces the subscription's apps with exactly these (one entry each), and turns each
   * catalogue app's `appAccess` on if it is listed, off if not. Other `appAccess` keys stay.
   */
  setApps(ndid: string, apps: AppAssignment[], now: Date): Promise<SubscriptionRecord | null>;
  list(search: SubscriptionSearch): Promise<SubscriptionPage>;
  findByNdid(ndid: string): Promise<SubscriptionRecord | null>;
  /** Subscriptions whose end date is in [from, to), with hotel name and plan, at most `limit` (renewal reminders). */
  endingBetween(from: Date, to: Date, limit: number): Promise<SubscriptionRecord[]>;
  /** endDate → now, keeps the time that was left. Null when there is no subscription. */
  pause(
    ndid: string,
    by: string,
    reason: string | null,
    now: Date,
    appsEnded?: boolean,
  ): Promise<SubscriptionRecord | null>;
  /** endDate → now + the time that was left when paused. */
  resume(ndid: string, now: Date): Promise<SubscriptionRecord | null>;
  /** endDate → `until`, status ACTIVE, any staff stop cleared; optionally a new plan. */
  renew(ndid: string, until: Date, planId: string | null, now: Date): Promise<SubscriptionRecord | null>;
  /** endDate → now, status EXPIRED, services off until renewed. */
  expire(
    ndid: string,
    by: string,
    reason: string | null,
    now: Date,
    appsEnded?: boolean,
  ): Promise<SubscriptionRecord | null>;
  changePlan(ndid: string, planId: string, now: Date): Promise<SubscriptionRecord | null>;
  /** clients staff have stopped, and (with `followExpiry`) every client whose subscription has ended */
  stoppedNdids(followExpiry: boolean, now: Date): Promise<string[]>;
}

// ─── billing (written by the billing module through SubscriptionBillingPort) ──────────────

/** What a hotel bought: a plan, a billing cycle, add-on apps and extra team seats. */
export interface PurchaseTerms {
  planId: string;
  /** the plan's `planName` (BASIC, PRO, …) when it was bought */
  planCode: string;
  cycleMonths: number;
  /** add-on app codes, beyond what the plan includes */
  addonCodes: string[];
  /** team seats beyond the plan's own */
  seats: number;
}

/** The paid period a hotel is in, kept on the subscription as `billing`. */
export interface BillingPeriod extends PurchaseTerms {
  periodStart: Date;
  periodEnd: Date;
  /** what was paid for this period before GST, in paise: the base for an upgrade credit */
  netPaise: number;
  /** our payments document's order id, or "staff" / "auto-renew:<payment id>" */
  paymentRef: string | null;
  purchasedAt: Date;
}

export type AutoRenewalStatus = "pending" | "active" | "halted" | "cancelled";

/** A Razorpay subscription (mandate) that renews the plan by itself, kept as `autoRenewal`. */
export interface AutoRenewal {
  status: AutoRenewalStatus;
  gatewaySubscriptionId: string;
  gatewayPlanId: string;
  /** charged every cycle, GST included, in paise */
  amountPaise: number;
  terms: PurchaseTerms;
  /** first charge */
  startAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** The raw subscription fields billing works from. */
export interface SubscriptionBillingSnapshot {
  ndid: string;
  planId: string | null;
  status: SubscriptionStatus;
  startDate: Date;
  endDate: Date;
  staffStop: StaffStop | null;
  lastPaymentId: string | null;
  apps: { appId: string; isTrial: boolean; startDate: Date; endDate: Date }[];
  appAccess: Record<string, boolean>;
  autoRenew: boolean;
  billing: BillingPeriod | null;
  autoRenewal: AutoRenewal | null;
}

/** A paid period being applied: everything on the subscription that follows from it. */
export interface ActivatePeriod {
  planId: string;
  startDate: Date;
  endDate: Date;
  /** exactly the apps the hotel now has */
  apps: { appId: string; startDate: Date; endDate: Date }[];
  /** keys to $set in appAccess; keys not listed stay as they are */
  appAccess: Record<string, boolean>;
  billing: BillingPeriod;
  orderId: string | null;
  paymentId: string | null;
}

/** Counts for the admin console's billing overview. */
export interface SubscriptionBillingStats {
  total: number;
  /** paid, running (not trial, not stopped, end ahead) */
  paying: number;
  trial: number;
  ended: number;
  stopped: number;
  /** paying ones ending in the next 30 days */
  renewalsDue30d: number;
  autoRenewOn: number;
  /** paying ones per plan code */
  byPlan: { planCode: string; count: number }[];
  /** paid periods' net value turned into a monthly figure, in paise */
  mrrPaise: number;
}

export interface SubscriptionBillingPort {
  snapshot(ndid: string): Promise<SubscriptionBillingSnapshot | null>;
  /** Applies a paid period; creates the subscription when the hotel has none. */
  activate(ndid: string, period: ActivatePeriod, now: Date): Promise<void>;
  setAutoRenewal(ndid: string, autoRenewal: AutoRenewal | null, autoRenew: boolean, now: Date): Promise<void>;
  findNdidByAutoRenewal(gatewaySubscriptionId: string): Promise<string | null>;
  stats(now: Date): Promise<SubscriptionBillingStats>;
}

/** Days before the end at which a subscription counts as "ending". */
export const ENDING_SOON_DAYS = 7;

/**
 * Whether a client's paid services run: the chatbot and lead alerts. The one place this rule
 * lives in gian-new; gian's src/services/clientServices.service.ts has the same rule.
 *
 * - no subscription: yes (old clients are never cut off by accident);
 * - stopped by staff (pause or expire): no;
 * - with `followExpiry`: no once `endDate` has passed or it was cancelled.
 */
export class SubscriptionRule {
  static serving(subscription: SubscriptionRecord | null, followExpiry: boolean, now = new Date()): boolean {
    if (!subscription) return true;
    if (subscription.staffStop) return false;
    if (!followExpiry) return true;
    return subscription.status !== "CANCELLED" && subscription.endDate > now;
  }

  static state(subscription: SubscriptionRecord, now = new Date()): SubscriptionState {
    if (subscription.staffStop) return "stopped";
    if (subscription.endDate <= now || subscription.status === "CANCELLED") return "ended";
    if (subscription.endDate.getTime() - now.getTime() <= ENDING_SOON_DAYS * 86_400_000) return "ending";
    return "active";
  }
}
