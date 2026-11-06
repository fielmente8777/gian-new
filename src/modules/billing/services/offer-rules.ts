import type { Offer, PurchaseKind } from "../types/billing.types.js";

export interface OfferContext {
  ndid: string;
  planCode: string;
  cycleMonths: number;
  kind: PurchaseKind;
  /** this hotel's successful payments with this offer */
  usesByClient: number;
  hasPaidBefore: boolean;
  now: Date;
}

/**
 * Whether an offer applies to a purchase. Returns null when it does, otherwise the reason in
 * words the hotel can read (shown under the code box). Pure, so it is unit-tested.
 */
export class OfferRules {
  static reject(offer: Offer | null, ctx: OfferContext): string | null {
    if (!offer || !offer.isActive) return "This code is not valid.";
    if (offer.ndids.length > 0 && !offer.ndids.includes(ctx.ndid)) return "This code is not valid.";
    if (offer.startsAt && offer.startsAt > ctx.now) return "This offer has not started yet.";
    if (offer.endsAt && offer.endsAt <= ctx.now) return "This offer has ended.";
    if (offer.maxRedemptions != null && offer.redemptions >= offer.maxRedemptions)
      return "This offer has been fully used.";
    if (offer.perClientLimit != null && ctx.usesByClient >= offer.perClientLimit)
      return "You have already used this code.";
    if (offer.firstPurchaseOnly && ctx.hasPaidBefore) return "This code is only for your first purchase.";
    if (offer.planCodes.length > 0 && !offer.planCodes.includes(ctx.planCode))
      return `This code works with the ${offer.planCodes.join(" / ")} plan only.`;
    if (offer.cycleMonths.length > 0 && !offer.cycleMonths.includes(ctx.cycleMonths))
      return `This code works with ${offer.cycleMonths.map((m) => (m === 1 ? "monthly" : `${m}-month`)).join(" / ")} billing only.`;
    if (offer.kinds.length > 0 && !offer.kinds.includes(ctx.kind)) {
      const words = { new: "a new plan", renew: "renewals", change: "plan changes" } as const;
      return `This code works for ${offer.kinds.map((k) => words[k]).join(" / ")} only.`;
    }
    return null;
  }

  static normalise(code: string | null | undefined): string | null {
    const trimmed = (code ?? "").trim().toUpperCase();
    return trimmed || null;
  }
}
