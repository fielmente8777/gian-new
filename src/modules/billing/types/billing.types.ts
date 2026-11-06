import type { PurchaseTerms } from "../../subscriptions/index.js";

// ─── catalogue (what Eazotel sells; edited from the admin console) ────────────────────────

/** -1 means unlimited. */
export interface PlanLimits {
  teamMembers: number;
  properties: number;
  aiCreditsMonthly: number;
  maxLeadsPerMonth: number;
}

export type SupportLevel = "none" | "standard" | "premium" | "enterprise";

/**
 * A plan (gian's `plans` collection). `price` is per month in rupees, before GST. A plan
 * includes some apps; the others can be added on at their own price.
 */
export interface CataloguePlan {
  id: string;
  /** `planName` in the database: TRIAL, BASIC, PRO, ENTERPRISE, or one staff created */
  code: string;
  name: string;
  tagline: string;
  price: number;
  /** app codes the plan includes */
  includedApps: string[];
  /** marketing bullet points shown on the plan card */
  highlights: string[];
  limits: PlanLimits;
  support: SupportLevel;
  /** on the website's pricing page and every hotel's plans page */
  isPublic: boolean;
  /** "Contact sales" instead of a price, unless the client is in `visibleTo` and price > 0 */
  isCustom: boolean;
  /** shown in place of the price on a custom plan, e.g. "Let's talk" */
  customPriceLabel: string;
  /** the line under it */
  customPriceNote: string;
  /** the button that opens a chat with sales */
  customCtaLabel: string;
  /** hotels (ndid) that can also see and buy this plan: a custom enterprise offer for one hotel */
  visibleTo: string[];
  /** false = archived: nobody can buy it, hotels already on it keep it until their end date */
  isActive: boolean;
  /** "Most popular" badge */
  featured: boolean;
  sortOrder: number;
  updatedAt: Date | null;
}

/** An add-on app (gian's `apps` collection). `code` is its key in the subscription's `appAccess`. */
export interface CatalogueApp {
  id: string;
  code: string;
  name: string;
  description: string;
  /** per month in rupees, before GST */
  price: number;
  isActive: boolean;
  sortOrder: number;
}

/** A billing cycle and the discount it earns, e.g. 12 months, 30% off. */
export interface BillingCycle {
  months: number;
  label: string;
  discountPercent: number;
  isActive: boolean;
}

/** Eazotel's own details, printed on every invoice. */
export interface InvoiceSeller {
  name: string;
  /** one line per row */
  address: string;
  /** Indian state, decides CGST + SGST (same state as the hotel) or IGST */
  state: string;
  gstin: string;
  pan: string;
  email: string;
  phone: string;
  /** service accounting code printed on each line, empty = left out */
  sac: string;
  /** invoice numbers look like EZ/26-27/00001 */
  prefix: string;
}

/** One document, `billing_settings` `_id: "default"`. */
export interface BillingSettings {
  currency: string;
  gstPercent: number;
  /** per extra team member per month, in rupees */
  seatPrice: number;
  cycles: BillingCycle[];
  trialDays: number;
  invoice: InvoiceSeller;
  updatedAt: Date | null;
  updatedBy: string | null;
}

// ─── offers ────────────────────────────────────────────────────────────────────────────

/** new = no paid plan running; renew = same plan, apps and seats, from the current end; change = anything else, from today */
export type PurchaseKind = "new" | "renew" | "change";

export interface Offer {
  id: string;
  /** what the hotel types, upper case */
  code: string;
  name: string;
  description: string;
  type: "percent" | "flat";
  /** percent (1–100) or rupees */
  value: number;
  /** a cap for percent offers, in rupees; null = no cap */
  maxDiscount: number | null;
  /** empty = every plan */
  planCodes: string[];
  /** empty = every cycle */
  cycleMonths: number[];
  /** empty = every kind */
  kinds: PurchaseKind[];
  /** only for a hotel that never paid before */
  firstPurchaseOnly: boolean;
  /** empty = every hotel; otherwise a private offer for these hotels only */
  ndids: string[];
  startsAt: Date | null;
  endsAt: Date | null;
  /** null = unlimited */
  maxRedemptions: number | null;
  /** uses per hotel; null = unlimited */
  perClientLimit: number | null;
  redemptions: number;
  isActive: boolean;
  /** shown as a banner on the pricing and plans pages */
  showOnPricing: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type NewOffer = Omit<Offer, "id" | "redemptions" | "createdAt" | "updatedAt">;

// ─── quotes and payments ───────────────────────────────────────────────────────────────

/** What the hotel picked. The server prices it; the browser never sends an amount. */
export interface PurchaseChoice {
  planId: string;
  cycleMonths: number;
  addonCodes: string[];
  seats: number;
  offerCode?: string | null;
}

export interface QuoteLine {
  kind: "plan" | "addon" | "seats";
  code: string;
  label: string;
  /** per month, in paise */
  monthlyPaise: number;
}

/** A priced choice. Every amount is in paise; rupees = paise / 100. */
export interface Quote {
  kind: PurchaseKind;
  plan: { id: string; code: string; name: string };
  cycleMonths: number;
  cycleLabel: string;
  lines: QuoteLine[];
  /** apps the plan includes and the add-ons, as codes */
  includedApps: string[];
  addonCodes: string[];
  seats: number;
  monthlyPaise: number;
  grossPaise: number;
  cycleDiscountPercent: number;
  cycleDiscountPaise: number;
  offer: { code: string; name: string; discountPaise: number } | null;
  /** why the offer code was not applied, for the hotel to read */
  offerError: string | null;
  /** unused value of the current paid period, taken off on a change */
  creditPaise: number;
  /** credit left over after the new period is fully paid, turned into extra days at the end */
  bonusDays: number;
  taxablePaise: number;
  gstPercent: number;
  gstPaise: number;
  totalPaise: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  /** what each auto-renewal would charge (GST included, no offer, no credit) */
  renewalPaise: number;
}

export type PaymentStatus = "created" | "SUCCESS" | "FAILED";
export type PaymentKind = PurchaseKind | "auto_renew";

/**
 * gian's `payments` collection, shared: gian's old checkout writes the same shape. Ours add
 * `source: "gian-new"`, the terms, the quote and when it was applied.
 */
export interface PaymentRecord {
  id: string;
  ndid: string;
  orderId: string;
  paymentId: string | null;
  planId: string | null;
  /** paise */
  amount: number;
  currency: string;
  status: PaymentStatus;
  method: string | null;
  paidAt: Date | null;
  createdAt: Date;
  source: string | null;
  kind: PaymentKind | null;
  terms: PurchaseTerms | null;
  quote: Quote | null;
  offerCode: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  appliedAt: Date | null;
  autoRenewRequested: boolean;
  failureReason: string | null;
  createdBy: string | null;
}

export type NewPayment = Omit<PaymentRecord, "id" | "appliedAt" | "failureReason">;

export interface PaymentQuery {
  page: number;
  pageSize: number;
  status?: PaymentStatus;
  ndid?: string;
  /** only these hotels (an admin's assigned clients); undefined = all */
  ndids?: string[];
  from?: Date;
  to?: Date;
  /** only paid ones made through gian-new or gian */
  source?: "gian-new" | "gian";
}

export interface PaymentListItem extends PaymentRecord {
  hotelName: string | null;
  planCode: string | null;
}

export interface PaymentPage {
  items: PaymentListItem[];
  total: number;
}

export interface RevenueSummary {
  /** paise, successful payments */
  thisMonthPaise: number;
  lastMonthPaise: number;
  last30DaysPaise: number;
  allTimePaise: number;
  paymentsThisMonth: number;
  /** distinct hotels that paid in the last 365 days */
  payingHotels12m: number;
  /** the last 12 calendar months, oldest first, India time */
  byMonth: { month: string; paise: number; count: number }[];
}

// ─── storage ports ─────────────────────────────────────────────────────────────────────

export type PlanInput = Omit<CataloguePlan, "id" | "updatedAt">;
/** What staff save; invoice details left out (or partly given) keep their stored values. */
export type SettingsInput = Omit<BillingSettings, "updatedAt" | "updatedBy" | "invoice"> & { invoice?: Partial<InvoiceSeller> };
export type AppInput = Omit<CatalogueApp, "id">;

export interface CatalogueStore {
  plans(): Promise<CataloguePlan[]>;
  plan(id: string): Promise<CataloguePlan | null>;
  createPlan(input: PlanInput, by: string, now: Date): Promise<CataloguePlan>;
  updatePlan(id: string, changes: Partial<PlanInput>, by: string, now: Date): Promise<CataloguePlan | null>;
  apps(): Promise<CatalogueApp[]>;
  createApp(input: AppInput, now: Date): Promise<CatalogueApp>;
  updateApp(id: string, changes: Partial<AppInput>, now: Date): Promise<CatalogueApp | null>;
  settings(): Promise<BillingSettings>;
  saveSettings(settings: Omit<BillingSettings, "updatedAt" | "updatedBy">, by: string, now: Date): Promise<BillingSettings>;
}

export interface OfferStore {
  list(): Promise<Offer[]>;
  byId(id: string): Promise<Offer | null>;
  byCode(code: string): Promise<Offer | null>;
  create(input: NewOffer, now: Date): Promise<Offer>;
  update(id: string, changes: Partial<NewOffer>, now: Date): Promise<Offer | null>;
  /** counts one use, once a payment with it is applied */
  redeem(code: string): Promise<void>;
}

export interface PaymentStore {
  create(payment: NewPayment): Promise<PaymentRecord>;
  findByOrderId(orderId: string): Promise<PaymentRecord | null>;
  /**
   * Marks an order paid and takes it for applying, only if nobody applied it and nobody took
   * it in the last 2 minutes. Returns the payment when this call won, null otherwise (the
   * browser and the webhook race; a crash halfway lets the webhook's retry take it again).
   */
  claim(orderId: string, paid: { paymentId: string; method: string | null; paidAt: Date }, now: Date): Promise<PaymentRecord | null>;
  /** the subscription was updated for this order */
  markApplied(orderId: string, now: Date): Promise<void>;
  markFailed(orderId: string, reason: string, paymentId: string | null): Promise<void>;
  /** Records a payment that is already applied (auto-renew charge). False when it was already recorded. */
  insertApplied(payment: NewPayment, now: Date): Promise<boolean>;
  list(query: PaymentQuery): Promise<PaymentPage>;
  /** successful payments with this offer by this hotel */
  offerUses(ndid: string, offerCode: string): Promise<number>;
  /** whether the hotel ever paid */
  hasPaid(ndid: string): Promise<boolean>;
  lastSuccessful(ndid: string): Promise<PaymentRecord | null>;
  revenue(now: Date): Promise<RevenueSummary>;
}

// ─── invoices ──────────────────────────────────────────────────────────────────────────

/** Who the invoice is from or to, as printed. */
export interface InvoiceParty {
  name: string;
  addressLines: string[];
  state: string | null;
  gstin: string | null;
  email: string | null;
  phone: string | null;
  pan?: string | null;
}

export interface InvoiceLine {
  description: string;
  sac: string | null;
  /** months */
  quantity: number;
  unitPaise: number;
  amountPaise: number;
}

/** A GST invoice for one successful payment (`billing_invoices`). Never changed once issued. */
export interface InvoiceRecord {
  id: string;
  /** EZ/26-27/00001 */
  number: string;
  ndid: string;
  /** the payment's order id: one invoice per payment */
  orderId: string;
  paymentId: string | null;
  issuedAt: Date;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  placeOfSupply: string | null;
  lines: InvoiceLine[];
  /** discounts and credits, negative */
  adjustments: { label: string; amountPaise: number }[];
  taxablePaise: number;
  taxes: { label: string; percent: number; amountPaise: number }[];
  totalPaise: number;
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  emailedTo: string[];
  lastEmailedAt: Date | null;
}

export type NewInvoice = Omit<InvoiceRecord, "id" | "number" | "emailedTo" | "lastEmailedAt">;

/** What the hotel wants on its invoices (`billing_profiles`, one per hotel). */
export interface BillingDetails {
  legalName: string;
  gstin: string;
  address: string;
  city: string;
  state: string;
  pinCode: string;
  email: string;
}

export interface InvoiceStore {
  /** Saves with the next number of the financial year; an invoice already made for the order is returned instead. */
  create(invoice: NewInvoice, numberFor: (seq: number) => string, yearKey: string): Promise<InvoiceRecord>;
  byId(id: string): Promise<InvoiceRecord | null>;
  byOrderId(orderId: string): Promise<InvoiceRecord | null>;
  /** order id → { id, number } */
  numbersFor(orderIds: string[]): Promise<Map<string, { id: string; number: string }>>;
  markEmailed(id: string, to: string[], at: Date): Promise<void>;
}

export interface BillingDetailsStore {
  get(ndid: string): Promise<BillingDetails | null>;
  save(ndid: string, details: BillingDetails, now: Date): Promise<void>;
}
