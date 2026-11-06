import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SubscriptionBillingSnapshot } from "../../subscriptions/index.js";
import { DEFAULT_BILLING_SETTINGS } from "../constants/billing.constants.js";
import { BillingDates } from "../services/billing-dates.js";
import { EntitlementBuilder } from "../services/entitlement-builder.js";
import { OfferRules, type OfferContext } from "../services/offer-rules.js";
import { PriceCalculator, type PriceInput } from "../services/price-calculator.js";
import { PurchasePlanner } from "../services/purchase-planner.js";
import type { Offer } from "../types/billing.types.js";
import { CAT_APPS, offerInput, planByCode } from "./fakes.js";

const settings = { ...DEFAULT_BILLING_SETTINGS, updatedAt: null, updatedBy: null };
const NOW = new Date("2026-11-06T10:00:00Z");
const DAY = 86_400_000;

const input = (extra: Partial<PriceInput> = {}): PriceInput => ({
  settings,
  plan: planByCode("PRO"),
  catalogue: CAT_APPS,
  cycleMonths: 12,
  addonCodes: [],
  seats: 0,
  kind: "new",
  periodStart: NOW,
  creditPaise: 0,
  offer: null,
  offerError: null,
  ...extra,
});

const offer = (extra: Partial<Offer> = {}): Offer => ({
  ...offerInput("SAVE10"),
  id: "o1",
  redemptions: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

describe("PriceCalculator", () => {
  it("prices a yearly PRO plan: 12 months, 30% off, then 18% GST", () => {
    const q = PriceCalculator.quote(input());
    assert.equal(q.monthlyPaise, 99_900);
    assert.equal(q.grossPaise, 1_198_800);
    assert.equal(q.cycleDiscountPaise, 359_640);
    assert.equal(q.taxablePaise, 839_160);
    assert.equal(q.gstPaise, 151_049);
    assert.equal(q.totalPaise, 990_209);
    assert.equal(q.periodEnd.toISOString(), "2027-11-06T10:00:00.000Z");
    assert.equal(q.renewalPaise, 990_209);
  });

  it("charges add-ons the plan doesn't include and extra seats; included apps cost nothing", () => {
    const q = PriceCalculator.quote(input({ cycleMonths: 1, addonCodes: ["whatsapp", "exotel"], seats: 2 }));
    // whatsapp is in PRO, so only exotel (₹1000) and 2 seats (₹500 each) are added
    assert.deepEqual(q.addonCodes, ["exotel"]);
    assert.equal(q.monthlyPaise, 99_900 + 100_000 + 100_000);
    assert.equal(q.cycleDiscountPaise, 0);
    assert.equal(q.lines.length, 3);
  });

  it("refuses an inactive or unknown app and a cycle that isn't offered", () => {
    assert.throws(() => PriceCalculator.quote(input({ addonCodes: ["grm"] })), { code: "APP_NOT_AVAILABLE" });
    assert.throws(() => PriceCalculator.quote(input({ addonCodes: ["nope"] })), { code: "APP_NOT_AVAILABLE" });
    assert.throws(() => PriceCalculator.quote(input({ cycleMonths: 2 })), { code: "CYCLE_NOT_AVAILABLE" });
  });

  it("takes a percent offer after the cycle discount, capped by maxDiscount", () => {
    const capped = PriceCalculator.quote(input({ offer: offer({ value: 50, maxDiscount: 1000 }) }));
    assert.equal(capped.offer?.discountPaise, 100_000);
    assert.equal(capped.taxablePaise, 839_160 - 100_000);
    const flat = PriceCalculator.quote(input({ cycleMonths: 1, offer: offer({ type: "flat", value: 5000 }) }));
    assert.equal(flat.offer?.discountPaise, 99_900, "a flat offer never goes below zero");
    assert.equal(flat.totalPaise, 0);
  });

  it("takes the credit last and never below zero; a total under ₹1 is waived", () => {
    const q = PriceCalculator.quote(input({ cycleMonths: 1, kind: "change", creditPaise: 10_000_000 }));
    assert.equal(q.creditPaise, 99_900);
    assert.equal(q.totalPaise, 0);
    assert.equal(q.bonusDays, 3 * 365, "leftover credit becomes extra days, capped at 3 years");
    const some = PriceCalculator.quote(input({ cycleMonths: 1, kind: "change", creditPaise: 99_900 * 2 }));
    assert.ok(some.bonusDays >= 29 && some.bonusDays <= 31, `one extra month (${some.bonusDays})`);
    assert.equal(some.periodEnd.getTime() - NOW.getTime(), (30 + some.bonusDays) * DAY);
    const tiny = PriceCalculator.quote(input({ cycleMonths: 1, kind: "change", creditPaise: 99_850 }));
    assert.equal(tiny.totalPaise, 0, "50 paise + GST is under Razorpay's ₹1 minimum");
  });

  it("works out the unused value of a period", () => {
    const start = new Date(NOW.getTime() - 100 * DAY);
    const end = new Date(NOW.getTime() + 100 * DAY);
    assert.equal(PriceCalculator.unusedValue(200_000, start, end, NOW), 100_000);
    assert.equal(PriceCalculator.unusedValue(200_000, start, new Date(NOW.getTime() - 1), NOW), 0);
    assert.equal(PriceCalculator.unusedValue(200_000, new Date(NOW.getTime() + DAY), end, NOW), 200_000);
  });
});

describe("OfferRules", () => {
  const ctx: OfferContext = { ndid: "h1", planCode: "PRO", cycleMonths: 12, kind: "new", usesByClient: 0, hasPaidBefore: false, now: NOW };

  it("accepts a plain active offer", () => {
    assert.equal(OfferRules.reject(offer(), ctx), null);
  });

  it("explains every reason an offer doesn't apply", () => {
    assert.match(OfferRules.reject(null, ctx)!, /not valid/);
    assert.match(OfferRules.reject(offer({ isActive: false }), ctx)!, /not valid/);
    assert.match(OfferRules.reject(offer({ ndids: ["other"] }), ctx)!, /not valid/);
    assert.match(OfferRules.reject(offer({ startsAt: new Date(NOW.getTime() + DAY) }), ctx)!, /not started/);
    assert.match(OfferRules.reject(offer({ endsAt: NOW }), ctx)!, /ended/);
    assert.match(OfferRules.reject(offer({ maxRedemptions: 5, redemptions: 5 }), ctx)!, /fully used/);
    assert.match(OfferRules.reject(offer(), { ...ctx, usesByClient: 1 })!, /already used/);
    assert.match(OfferRules.reject(offer({ firstPurchaseOnly: true }), { ...ctx, hasPaidBefore: true })!, /first purchase/);
    assert.match(OfferRules.reject(offer({ planCodes: ["BASIC"] }), ctx)!, /BASIC plan only/);
    assert.match(OfferRules.reject(offer({ cycleMonths: [1] }), ctx)!, /monthly billing only/);
    assert.match(OfferRules.reject(offer({ kinds: ["renew"] }), ctx)!, /renewals only/);
  });

  it("normalises what the hotel typed", () => {
    assert.equal(OfferRules.normalise("  diwali25 "), "DIWALI25");
    assert.equal(OfferRules.normalise("   "), null);
  });
});

describe("PurchasePlanner", () => {
  const paid = (extra: Partial<SubscriptionBillingSnapshot> = {}): SubscriptionBillingSnapshot => ({
    ndid: "h1",
    planId: planByCode("PRO").id,
    status: "ACTIVE",
    startDate: new Date(NOW.getTime() - 30 * DAY),
    endDate: new Date(NOW.getTime() + 335 * DAY),
    staffStop: null,
    lastPaymentId: "pay_1",
    apps: [],
    appAccess: {},
    autoRenew: false,
    billing: {
      planId: planByCode("PRO").id,
      planCode: "PRO",
      cycleMonths: 12,
      addonCodes: ["exotel"],
      seats: 0,
      periodStart: new Date(NOW.getTime() - 30 * DAY),
      periodEnd: new Date(NOW.getTime() + 335 * DAY),
      netPaise: 1_000_000,
      paymentRef: "order_1",
      purchasedAt: NOW,
    },
    autoRenewal: null,
    ...extra,
  });

  it("tells trial, active, ending, ended and stopped apart", () => {
    assert.equal(PurchasePlanner.phase(null, NOW), "none");
    assert.equal(PurchasePlanner.phase(paid(), NOW), "active");
    assert.equal(PurchasePlanner.phase(paid({ endDate: new Date(NOW.getTime() + 3 * DAY) }), NOW), "ending");
    assert.equal(PurchasePlanner.phase(paid({ endDate: NOW }), NOW), "ended");
    assert.equal(
      PurchasePlanner.phase(paid({ staffStop: { kind: "paused", at: NOW, by: "x", reason: null, remainingMs: 0 } }), NOW),
      "stopped",
    );
    const trial = paid({ billing: null, lastPaymentId: null, apps: [{ appId: "a", isTrial: true, startDate: NOW, endDate: NOW }] });
    assert.equal(PurchasePlanner.phase(trial, NOW), "trial");
  });

  it("calls the same plan, add-ons and seats a renewal, anything else a change", () => {
    const pro = planByCode("PRO");
    const current = PurchasePlanner.currentTerms(paid(), [pro], CAT_APPS, settings, NOW);
    assert.equal(PurchasePlanner.kind("active", current, pro, ["exotel", "whatsapp"], 0), "renew", "whatsapp is included in PRO");
    assert.equal(PurchasePlanner.kind("active", current, pro, [], 0), "change");
    assert.equal(PurchasePlanner.kind("active", current, pro, ["exotel"], 1), "change");
    assert.equal(PurchasePlanner.kind("active", current, planByCode("BASIC"), ["exotel"], 0), "change");
    assert.equal(PurchasePlanner.kind("ended", current, pro, ["exotel"], 0), "new");
    assert.equal(PurchasePlanner.kind("trial", null, pro, [], 0), "new");
  });

  it("works out older purchases from the plan and the paid apps", () => {
    const legacy = paid({
      billing: null,
      apps: [
        { appId: CAT_APPS[1]!.id, isTrial: false, startDate: NOW, endDate: new Date(NOW.getTime() + DAY) },
        { appId: CAT_APPS[3]!.id, isTrial: false, startDate: NOW, endDate: new Date(NOW.getTime() + DAY) },
      ],
    });
    const terms = PurchasePlanner.currentTerms(legacy, [planByCode("PRO")], CAT_APPS, settings, NOW);
    assert.deepEqual(terms?.addonCodes, ["exotel"], "whatsapp is in PRO, so only exotel counts as an add-on");
    assert.equal(terms?.cycleMonths, 12);
  });
});

describe("EntitlementBuilder", () => {
  it("turns on exactly the plan's apps and the add-ons, and every core area", () => {
    const start = NOW;
    const end = BillingDates.addMonths(NOW, 1);
    const result = EntitlementBuilder.build({
      plan: planByCode("BASIC"),
      catalogue: CAT_APPS,
      addonCodes: ["exotel"],
      periodStart: start,
      periodEnd: end,
      existing: [{ appId: CAT_APPS[0]!.id, startDate: new Date("2026-01-01") }],
    });
    assert.deepEqual(result.enabledCodes.sort(), ["exotel", "lead_management"]);
    assert.equal(result.appAccess.whatsapp, false);
    assert.equal(result.appAccess.eazbot, false);
    assert.equal(result.appAccess.exotel, true);
    assert.equal(result.appAccess.cms, true);
    assert.equal(result.apps.find((a) => a.appId === CAT_APPS[0]!.id)?.startDate.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.ok(result.apps.every((a) => a.endDate === end));
  });
});

describe("BillingDates", () => {
  it("adds months without running past the end of a short month", () => {
    assert.equal(BillingDates.addMonths(new Date("2026-01-31T12:00:00Z"), 1).toISOString(), "2026-02-28T12:00:00.000Z");
    assert.equal(BillingDates.addMonths(new Date("2026-03-15T00:00:00Z"), 12).toISOString(), "2027-03-15T00:00:00.000Z");
  });
});
