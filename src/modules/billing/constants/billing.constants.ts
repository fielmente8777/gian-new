import type { BillingSettings, PlanLimits } from "../types/billing.types.js";

/**
 * Dashboard areas every paid plan (and the trial) unlocks. They are `appAccess` keys like the
 * app codes, but nobody buys them separately. Keys not listed here and not an app code are
 * never touched by billing.
 */
export const CORE_FEATURE_KEYS = [
  "cms",
  "frontDesk",
  "usermanagement",
  "analyticsandreporting",
  "google_analytics",
  "gatewayManager",
  "eazmail",
  "seoManager",
  "smsmarketing",
] as const;

/** Used until staff save settings for the first time (prices as they were in gian). */
export const DEFAULT_BILLING_SETTINGS: Omit<BillingSettings, "updatedAt" | "updatedBy"> = {
  currency: "INR",
  gstPercent: 18,
  seatPrice: 500,
  trialDays: 14,
  invoice: {
    name: "Eazotel Technologies Pvt Ltd",
    address: "",
    state: "",
    gstin: "",
    pan: "",
    email: "support@eazotel.com",
    phone: "",
    sac: "",
    prefix: "EZ",
  },
  cycles: [
    { months: 1, label: "Monthly", discountPercent: 0, isActive: true },
    { months: 3, label: "Quarterly", discountPercent: 10, isActive: true },
    { months: 6, label: "Half-yearly", discountPercent: 15, isActive: true },
    { months: 12, label: "Yearly", discountPercent: 30, isActive: true },
  ],
};

/** What a custom plan shows in place of a price, until staff write their own. */
export const DEFAULT_CUSTOM_PRICING = {
  customPriceLabel: "Let's talk",
  customPriceNote: "A quote built around your properties",
  customCtaLabel: "Talk to sales",
} as const;

export const UNLIMITED = -1;

export const DEFAULT_LIMITS: PlanLimits = { teamMembers: 1, properties: 1, aiCreditsMonthly: 0, maxLeadsPerMonth: UNLIMITED };

/** The plan code nobody can buy: new hotels get it (or ENTERPRISE) for the free trial. */
export const TRIAL_PLAN_CODE = "TRIAL";

/** Razorpay needs at least ₹1. */
export const MIN_CHARGE_PAISE = 100;

/** How many renewals one auto-renew mandate allows (Razorpay needs a number): about 10 years. */
export const AUTO_RENEW_YEARS = 10;
