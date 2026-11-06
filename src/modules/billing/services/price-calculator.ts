import { MIN_CHARGE_PAISE } from "../constants/billing.constants.js";
import { AppNotAvailableError, CycleNotAvailableError } from "../errors/billing.errors.js";
import type {
  BillingCycle,
  BillingSettings,
  CatalogueApp,
  CataloguePlan,
  Offer,
  PurchaseKind,
  Quote,
  QuoteLine,
} from "../types/billing.types.js";
import { BillingDates } from "./billing-dates.js";

export interface PriceInput {
  settings: BillingSettings;
  plan: CataloguePlan;
  catalogue: CatalogueApp[];
  cycleMonths: number;
  /** what the hotel picked; codes the plan already includes are dropped */
  addonCodes: string[];
  seats: number;
  kind: PurchaseKind;
  periodStart: Date;
  /** unused value of the current period (change only), before GST */
  creditPaise: number;
  /** an offer already checked with OfferRules, or null */
  offer: Offer | null;
  offerError: string | null;
}

const paise = (rupees: number) => Math.round(rupees * 100);
const MAX_BONUS_DAYS = 3 * 365;

/**
 * Prices a purchase. Pure: no database, no clock, so every rule here is unit-tested.
 *
 *   monthly  = plan + each add-on + extra seats × seat price
 *   gross    = monthly × months
 *   − cycle discount (e.g. 30% on yearly)
 *   − offer (percent with an optional cap, or a flat amount)
 *   − credit for the unused part of the current period (plan change only)
 *   = taxable;  + GST  = total
 *
 * Every step rounds to whole paise. The total is never negative; a total under ₹1 (Razorpay's
 * minimum) is waived by taking the rest off the credit. Credit left over after that (a cheaper
 * choice than what was left) becomes extra days at the end of the new period.
 */
export class PriceCalculator {
  static cycle(settings: BillingSettings, months: number): BillingCycle {
    const cycle = settings.cycles.find((c) => c.months === months && c.isActive);
    if (!cycle) throw new CycleNotAvailableError();
    return cycle;
  }

  /** The add-ons that cost extra: picked, not in the plan, each an active catalogue app. */
  static addons(plan: CataloguePlan, catalogue: CatalogueApp[], codes: string[]): CatalogueApp[] {
    const included = new Set(plan.includedApps);
    const byCode = new Map(catalogue.map((a) => [a.code, a]));
    const picked = [...new Set(codes)].filter((code) => !included.has(code));
    return picked.map((code) => {
      const app = byCode.get(code);
      if (!app || !app.isActive) throw new AppNotAvailableError(code);
      return app;
    });
  }

  static quote(input: PriceInput): Quote {
    const { settings, plan, catalogue, cycleMonths, seats, kind, periodStart, offer } = input;
    const cycle = PriceCalculator.cycle(settings, cycleMonths);
    const addons = PriceCalculator.addons(plan, catalogue, input.addonCodes);

    const lines: QuoteLine[] = [
      { kind: "plan", code: plan.code, label: `${plan.name} plan`, monthlyPaise: paise(plan.price) },
      ...addons.map((a) => ({ kind: "addon" as const, code: a.code, label: a.name, monthlyPaise: paise(a.price) })),
      ...(seats > 0
        ? [{
            kind: "seats" as const,
            code: "seats",
            label: `${seats} extra team ${seats === 1 ? "seat" : "seats"}`,
            monthlyPaise: paise(settings.seatPrice) * seats,
          }]
        : []),
    ];
    const monthlyPaise = lines.reduce((sum, l) => sum + l.monthlyPaise, 0);
    const grossPaise = monthlyPaise * cycleMonths;
    const cycleDiscountPaise = Math.round((grossPaise * cycle.discountPercent) / 100);
    const afterCycle = grossPaise - cycleDiscountPaise;

    const offerDiscount = offer ? PriceCalculator.offerDiscount(offer, afterCycle) : 0;
    const availableCredit = Math.max(0, Math.round(input.creditPaise));
    let creditPaise = Math.min(availableCredit, afterCycle - offerDiscount);
    let taxablePaise = afterCycle - offerDiscount - creditPaise;
    let gstPaise = Math.round((taxablePaise * settings.gstPercent) / 100);
    if (taxablePaise + gstPaise > 0 && taxablePaise + gstPaise < MIN_CHARGE_PAISE) {
      creditPaise += taxablePaise;
      taxablePaise = 0;
      gstPaise = 0;
    }

    // a cheaper choice than what is left: the rest of the credit becomes extra days, never lost
    const periodEnd = BillingDates.addMonths(periodStart, cycleMonths);
    const leftover = availableCredit - creditPaise;
    const perDay = afterCycle / Math.max(1, BillingDates.daysBetween(periodStart, periodEnd));
    const bonusDays = leftover > 0 && perDay > 0 ? Math.min(MAX_BONUS_DAYS, Math.floor(leftover / perDay)) : 0;

    return {
      kind,
      plan: { id: plan.id, code: plan.code, name: plan.name },
      cycleMonths,
      cycleLabel: cycle.label,
      lines,
      includedApps: [...plan.includedApps],
      addonCodes: addons.map((a) => a.code),
      seats,
      monthlyPaise,
      grossPaise,
      cycleDiscountPercent: cycle.discountPercent,
      cycleDiscountPaise,
      offer: offer ? { code: offer.code, name: offer.name, discountPaise: offerDiscount } : null,
      offerError: input.offerError,
      creditPaise,
      bonusDays,
      taxablePaise,
      gstPercent: settings.gstPercent,
      gstPaise,
      totalPaise: taxablePaise + gstPaise,
      currency: settings.currency,
      periodStart,
      periodEnd: new Date(periodEnd.getTime() + bonusDays * 86_400_000),
      renewalPaise: afterCycle + Math.round((afterCycle * settings.gstPercent) / 100),
    };
  }

  static offerDiscount(offer: Offer, basePaise: number): number {
    if (offer.type === "flat") return Math.min(basePaise, paise(offer.value));
    const percent = Math.round((basePaise * Math.min(100, offer.value)) / 100);
    const capped = offer.maxDiscount != null ? Math.min(percent, paise(offer.maxDiscount)) : percent;
    return Math.min(basePaise, capped);
  }

  /**
   * Unused value of a paid period: what was paid (before GST) times the share of the period
   * still ahead. Nothing once it has ended; everything if it hasn't started yet.
   */
  static unusedValue(netPaise: number, periodStart: Date, periodEnd: Date, now: Date): number {
    const length = periodEnd.getTime() - periodStart.getTime();
    if (netPaise <= 0 || length <= 0 || periodEnd <= now) return 0;
    const left = Math.min(1, (periodEnd.getTime() - now.getTime()) / length);
    return Math.round(netPaise * left);
  }
}
