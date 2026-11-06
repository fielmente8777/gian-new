import { ENDING_SOON_DAYS, type PurchaseTerms, type SubscriptionBillingSnapshot } from "../../subscriptions/index.js";
import type { BillingSettings, CatalogueApp, CataloguePlan, PaymentRecord, PurchaseKind } from "../types/billing.types.js";

/** Where a hotel stands, as the plans page shows it. */
export type BillingPhase = "none" | "trial" | "active" | "ending" | "ended" | "stopped";

/**
 * Reads a subscription: the phase, what the hotel is paying for now, and what a new purchase
 * would be. Pure, so it is unit-tested; the checkout gives it the data.
 */
export class PurchasePlanner {
  static phase(snapshot: SubscriptionBillingSnapshot | null, now: Date): BillingPhase {
    if (!snapshot) return "none";
    if (snapshot.staffStop) return "stopped";
    if (snapshot.endDate <= now || snapshot.status === "CANCELLED") return "ended";
    if (PurchasePlanner.isTrial(snapshot)) return "trial";
    if (snapshot.endDate.getTime() - now.getTime() <= ENDING_SOON_DAYS * 86_400_000) return "ending";
    return "active";
  }

  /** Never paid: no billing period, no payment, and every app is a trial one (gian's 14-day start). */
  static isTrial(snapshot: SubscriptionBillingSnapshot): boolean {
    return !snapshot.billing && !snapshot.lastPaymentId && snapshot.apps.every((a) => a.isTrial);
  }

  /**
   * What the hotel pays for now. Purchases made here are stored on the subscription; for older
   * ones (gian's checkout, staff renewals) it is worked out from the plan and the paid apps.
   */
  static currentTerms(
    snapshot: SubscriptionBillingSnapshot | null,
    plans: CataloguePlan[],
    catalogue: CatalogueApp[],
    settings: BillingSettings,
    now: Date,
  ): PurchaseTerms | null {
    if (!snapshot || PurchasePlanner.isTrial(snapshot)) return null;
    if (snapshot.billing) {
      const { planId, planCode, cycleMonths, addonCodes, seats } = snapshot.billing;
      return { planId, planCode, cycleMonths, addonCodes, seats };
    }
    const plan = plans.find((p) => p.id === snapshot.planId);
    if (!plan) return null;
    const included = new Set(plan.includedApps);
    const codes = new Map(catalogue.map((a) => [a.id, a.code]));
    const addonCodes = [
      ...new Set(
        snapshot.apps
          .filter((a) => !a.isTrial && a.endDate > now)
          .map((a) => codes.get(a.appId))
          .filter((c): c is string => Boolean(c) && !included.has(c!)),
      ),
    ];
    // the closest cycle to the length of the current period
    const months = Math.max(1, Math.round((snapshot.endDate.getTime() - snapshot.startDate.getTime()) / (30.44 * 86_400_000)));
    const cycles = settings.cycles.filter((c) => c.isActive).map((c) => c.months);
    const cycleMonths = cycles.length
      ? cycles.reduce((best, m) => (Math.abs(m - months) < Math.abs(best - months) ? m : best), cycles[0]!)
      : 1;
    return { planId: plan.id, planCode: plan.code, cycleMonths, addonCodes, seats: 0 };
  }

  /**
   * new: no paid plan is running (no subscription, trial, ended, stopped by staff).
   * renew: the same plan, add-ons and seats: the period is added after the current one.
   * change: anything else while paid: a new period starts today, with a credit for the rest.
   */
  static kind(
    phase: BillingPhase,
    current: PurchaseTerms | null,
    plan: CataloguePlan,
    addonCodes: string[],
    seats: number,
  ): PurchaseKind {
    if (!current || (phase !== "active" && phase !== "ending")) return "new";
    const included = new Set(plan.includedApps);
    const norm = (codes: string[]) => [...new Set(codes.filter((c) => !included.has(c)))].sort().join(",");
    const same = current.planId === plan.id && norm(current.addonCodes) === norm(addonCodes) && current.seats === seats;
    return same ? "renew" : "change";
  }

  /**
   * What the current period was worth before GST, and its dates: the base for a change's
   * credit. Periods bought here store it; for older ones it is the last payment without GST,
   * spread over the subscription's current dates.
   */
  static creditBase(
    snapshot: SubscriptionBillingSnapshot | null,
    lastPayment: PaymentRecord | null,
    gstPercent: number,
  ): { netPaise: number; start: Date; end: Date } | null {
    if (!snapshot || snapshot.staffStop || PurchasePlanner.isTrial(snapshot)) return null;
    if (snapshot.billing) {
      return { netPaise: snapshot.billing.netPaise, start: snapshot.billing.periodStart, end: snapshot.billing.periodEnd };
    }
    if (!lastPayment || lastPayment.amount <= 0) return null;
    return {
      netPaise: Math.round(lastPayment.amount / (1 + gstPercent / 100)),
      start: snapshot.startDate,
      end: snapshot.endDate,
    };
  }
}
