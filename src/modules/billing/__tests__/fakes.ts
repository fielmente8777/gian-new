import { createHmac } from "node:crypto";

import { pino } from "pino";

import type { Mailer, MailMessage } from "../../../integrations/mail/mailer.js";
import type { PaymentGateway } from "../../../integrations/razorpay/razorpay.client.js";
import type {
  ActivatePeriod,
  AutoRenewal,
  SubscriptionBillingPort,
  SubscriptionBillingSnapshot,
  SubscriptionBillingStats,
} from "../../subscriptions/index.js";
import { DEFAULT_BILLING_SETTINGS, DEFAULT_CUSTOM_PRICING } from "../constants/billing.constants.js";
import type { AuthenticateMiddleware } from "../../auth/index.js";
import { BillingModule } from "../billing.module.js";
import { BillingCatalogueService } from "../services/billing-catalogue.service.js";
import { BillingReportsService } from "../services/billing-reports.service.js";
import type { HotelInfo } from "../services/invoice.service.js";
import { FakeZohoBooks, InMemoryZohoStore, TEST_ZOHO_KEY, TEST_ZOHO_WEBHOOK_TOKEN } from "./zoho-fakes.js";
import type {
  AppInput,
  BillingDetails,
  BillingDetailsStore,
  BillingSettings,
  InvoiceRecord,
  InvoiceStore,
  NewInvoice,
  CatalogueApp,
  CataloguePlan,
  CatalogueStore,
  NewOffer,
  NewPayment,
  Offer,
  OfferStore,
  PaymentPage,
  PaymentQuery,
  PaymentRecord,
  PaymentStore,
  PlanInput,
  RevenueSummary,
} from "../types/billing.types.js";

let counter = 0;
const nextId = () => (++counter).toString(16).padStart(24, "c");

export const CAT_APPS: CatalogueApp[] = [
  {
    id: "a00000000000000000000001",
    code: "lead_management",
    name: "Lead Management",
    description: "",
    price: 500,
    isActive: true,
    sortOrder: 1,
  },
  {
    id: "a00000000000000000000002",
    code: "whatsapp",
    name: "WhatsApp Chat",
    description: "",
    price: 1000,
    isActive: true,
    sortOrder: 2,
  },
  {
    id: "a00000000000000000000003",
    code: "eazbot",
    name: "Eazbot",
    description: "",
    price: 500,
    isActive: true,
    sortOrder: 3,
  },
  {
    id: "a00000000000000000000004",
    code: "exotel",
    name: "Exotel Integration",
    description: "",
    price: 1000,
    isActive: true,
    sortOrder: 4,
  },
  {
    id: "a00000000000000000000005",
    code: "grm",
    name: "GRM",
    description: "",
    price: 500,
    isActive: false,
    sortOrder: 5,
  },
];

const limits = { teamMembers: 3, properties: 1, aiCreditsMonthly: 100, maxLeadsPerMonth: 200 };

export const CAT_PLANS: CataloguePlan[] = [
  plan("p00000000000000000000001", "TRIAL", 0, [], { isPublic: false }),
  plan("p00000000000000000000002", "BASIC", 499, ["lead_management"]),
  plan("p00000000000000000000003", "PRO", 999, ["lead_management", "whatsapp", "eazbot"], { featured: true }),
  plan("p00000000000000000000004", "ENTERPRISE", 0, ["lead_management", "whatsapp", "eazbot", "exotel"], {
    isCustom: true,
  }),
];

function plan(
  id: string,
  code: string,
  price: number,
  includedApps: string[],
  extra: Partial<CataloguePlan> = {},
): CataloguePlan {
  return {
    id: id.replace(/p/g, "f"),
    code,
    name: code.charAt(0) + code.slice(1).toLowerCase(),
    tagline: "",
    price,
    includedApps,
    highlights: [],
    limits,
    support: "standard",
    isPublic: true,
    isCustom: false,
    ...DEFAULT_CUSTOM_PRICING,
    visibleTo: [],
    isActive: true,
    featured: false,
    sortOrder: price,
    updatedAt: null,
    ...extra,
  };
}

export const planByCode = (code: string) => CAT_PLANS.find((p) => p.code === code)!;

export class InMemoryCatalogue implements CatalogueStore {
  plansList: CataloguePlan[] = CAT_PLANS.map((p) => ({ ...p }));
  appsList: CatalogueApp[] = CAT_APPS.map((a) => ({ ...a }));
  current: BillingSettings = { ...DEFAULT_BILLING_SETTINGS, updatedAt: null, updatedBy: null };

  async plans() {
    return this.plansList.map((p) => ({ ...p }));
  }
  async plan(id: string) {
    return this.plansList.find((p) => p.id === id) ?? null;
  }
  async createPlan(input: PlanInput, _by: string, now: Date) {
    const created = { ...input, id: nextId(), updatedAt: now };
    this.plansList.push(created);
    return created;
  }
  async updatePlan(id: string, changes: Partial<PlanInput>, _by: string, now: Date) {
    const index = this.plansList.findIndex((p) => p.id === id);
    if (index < 0) return null;
    this.plansList[index] = { ...this.plansList[index]!, ...changes, updatedAt: now };
    return this.plansList[index]!;
  }
  async apps() {
    return this.appsList.map((a) => ({ ...a }));
  }
  async createApp(input: AppInput) {
    const created = { ...input, id: nextId() };
    this.appsList.push(created);
    return created;
  }
  async updateApp(id: string, changes: Partial<AppInput>) {
    const index = this.appsList.findIndex((a) => a.id === id);
    if (index < 0) return null;
    this.appsList[index] = { ...this.appsList[index]!, ...changes };
    return this.appsList[index]!;
  }
  async settings() {
    return { ...this.current };
  }
  async saveSettings(settings: Omit<BillingSettings, "updatedAt" | "updatedBy">, by: string, now: Date) {
    this.current = { ...settings, updatedAt: now, updatedBy: by };
    return this.current;
  }
}

export class InMemoryOffers implements OfferStore {
  readonly rows: Offer[] = [];
  async list() {
    return [...this.rows];
  }
  async byId(id: string) {
    return this.rows.find((o) => o.id === id) ?? null;
  }
  async byCode(code: string) {
    return this.rows.find((o) => o.code === code.toUpperCase()) ?? null;
  }
  async create(input: NewOffer, now: Date) {
    const offer: Offer = { ...input, id: nextId(), redemptions: 0, createdAt: now, updatedAt: now };
    this.rows.push(offer);
    return offer;
  }
  async update(id: string, changes: Partial<NewOffer>, now: Date) {
    const offer = this.rows.find((o) => o.id === id);
    if (!offer) return null;
    Object.assign(offer, changes, { updatedAt: now });
    return offer;
  }
  async redeem(code: string) {
    const offer = this.rows.find((o) => o.code === code.toUpperCase());
    if (offer) offer.redemptions += 1;
  }
}

export const offerInput = (code: string, extra: Partial<NewOffer> = {}): NewOffer => ({
  code,
  name: code,
  description: "",
  type: "percent",
  value: 10,
  maxDiscount: null,
  planCodes: [],
  cycleMonths: [],
  kinds: [],
  firstPurchaseOnly: false,
  ndids: [],
  startsAt: null,
  endsAt: null,
  maxRedemptions: null,
  perClientLimit: 1,
  isActive: true,
  showOnPricing: false,
  ...extra,
});

export class InMemoryPayments implements PaymentStore {
  readonly rows: (PaymentRecord & { claimedAt: Date | null })[] = [];

  async create(p: NewPayment) {
    const record = { ...p, id: nextId(), appliedAt: null, failureReason: null, claimedAt: null };
    this.rows.push(record);
    return record;
  }
  async findByOrderId(orderId: string) {
    return this.rows.find((p) => p.orderId === orderId) ?? null;
  }
  async claim(orderId: string, paid: { paymentId: string; method: string | null; paidAt: Date }, now: Date) {
    const p = this.rows.find((r) => r.orderId === orderId && r.source === "gian-new");
    if (!p || p.appliedAt || (p.claimedAt && now.getTime() - p.claimedAt.getTime() < 120_000)) return null;
    Object.assign(p, {
      status: "SUCCESS",
      paymentId: paid.paymentId,
      method: paid.method,
      paidAt: paid.paidAt,
      claimedAt: now,
    });
    return { ...p };
  }
  async markApplied(orderId: string, now: Date) {
    const p = this.rows.find((r) => r.orderId === orderId);
    if (p) p.appliedAt = now;
  }
  async markFailed(orderId: string, reason: string, paymentId: string | null) {
    const p = this.rows.find((r) => r.orderId === orderId);
    if (p && p.status !== "SUCCESS")
      Object.assign(p, { status: "FAILED", failureReason: reason, paymentId: paymentId ?? p.paymentId });
  }
  async insertApplied(p: NewPayment, now: Date) {
    if (this.rows.some((r) => r.orderId === p.orderId)) return false;
    this.rows.push({ ...p, id: nextId(), appliedAt: now, failureReason: null, claimedAt: now });
    return true;
  }
  async list(q: PaymentQuery): Promise<PaymentPage> {
    const matching = this.rows
      .filter(
        (p) =>
          (!q.ndid || p.ndid === q.ndid) &&
          (!q.ndids || q.ndids.includes(p.ndid)) &&
          (!q.status || p.status === q.status),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      items: matching
        .slice((q.page - 1) * q.pageSize, q.page * q.pageSize)
        .map((p) => ({ ...p, hotelName: null, planCode: p.terms?.planCode ?? null })),
      total: matching.length,
    };
  }
  async offerUses(ndid: string, code: string) {
    return this.rows.filter((p) => p.ndid === ndid && p.offerCode === code.toUpperCase() && p.status === "SUCCESS")
      .length;
  }
  async hasPaid(ndid: string) {
    return this.rows.some((p) => p.ndid === ndid && p.status === "SUCCESS");
  }
  async lastSuccessful(ndid: string) {
    return this.rows.filter((p) => p.ndid === ndid && p.status === "SUCCESS").at(-1) ?? null;
  }
  async revenue(): Promise<RevenueSummary> {
    const paid = this.rows.filter((p) => p.status === "SUCCESS");
    const sum = paid.reduce((s, p) => s + p.amount, 0);
    return {
      thisMonthPaise: sum,
      lastMonthPaise: 0,
      last30DaysPaise: sum,
      allTimePaise: sum,
      paymentsThisMonth: paid.length,
      payingHotels12m: new Set(paid.map((p) => p.ndid)).size,
      byMonth: [],
    };
  }
}

/** In-memory subscriptions, as SubscriptionBillingRepository stores them. */
export class InMemorySubscriptionBilling implements SubscriptionBillingPort {
  readonly rows = new Map<string, SubscriptionBillingSnapshot>();

  /** gian's 14-day trial: ENTERPRISE, every app on as a trial. */
  addTrial(ndid: string, daysLeft: number, now = new Date()) {
    this.rows.set(ndid, {
      ndid,
      planId: planByCode("ENTERPRISE").id,
      status: "ACTIVE",
      startDate: new Date(now.getTime() - 3 * 86_400_000),
      endDate: new Date(now.getTime() + daysLeft * 86_400_000),
      staffStop: null,
      lastPaymentId: null,
      apps: CAT_APPS.map((a) => ({
        appId: a.id,
        isTrial: true,
        startDate: now,
        endDate: new Date(now.getTime() + daysLeft * 86_400_000),
      })),
      appAccess: Object.fromEntries(CAT_APPS.map((a) => [a.code, true])),
      autoRenew: false,
      billing: null,
      autoRenewal: null,
    });
  }

  async snapshot(ndid: string) {
    const row = this.rows.get(ndid);
    return row ? structuredClone(row) : null;
  }
  async activate(ndid: string, period: ActivatePeriod) {
    const current = this.rows.get(ndid);
    this.rows.set(ndid, {
      ndid,
      planId: period.planId,
      status: "ACTIVE",
      startDate: period.startDate,
      endDate: period.endDate,
      staffStop: null,
      lastPaymentId: period.paymentId ?? current?.lastPaymentId ?? null,
      apps: period.apps.map((a) => ({ ...a, isTrial: false })),
      appAccess: { ...(current?.appAccess ?? {}), ...period.appAccess },
      autoRenew: current?.autoRenew ?? false,
      billing: period.billing,
      autoRenewal: current?.autoRenewal ?? null,
    });
  }
  async setAutoRenewal(ndid: string, autoRenewal: AutoRenewal | null, autoRenew: boolean) {
    const row = this.rows.get(ndid);
    if (row) Object.assign(row, { autoRenewal, autoRenew });
  }
  async findNdidByAutoRenewal(id: string) {
    return [...this.rows.values()].find((r) => r.autoRenewal?.gatewaySubscriptionId === id)?.ndid ?? null;
  }
  async stats(): Promise<SubscriptionBillingStats> {
    return {
      total: this.rows.size,
      paying: 0,
      trial: 0,
      ended: 0,
      stopped: 0,
      renewalsDue30d: 0,
      autoRenewOn: 0,
      byPlan: [],
      mrrPaise: 0,
    };
  }
}

export const KEY_SECRET = "test_secret";
export const WEBHOOK_SECRET = "webhook_secret";
export const sign = (secret: string, payload: string | Buffer) =>
  createHmac("sha256", secret).update(payload).digest("hex");

/** Razorpay without the network; signatures are real HMACs with the test secrets. */
export class FakeGateway implements PaymentGateway {
  readonly keyId = "rzp_test_fake";
  readonly webhookEnabled = true;
  readonly orders: { id: string; amount: number }[] = [];
  readonly plans: { id: string; amountPaise: number; intervalMonths: number }[] = [];
  readonly subscriptions: { id: string; startAt: Date | null; cancelled: boolean }[] = [];

  async createOrder(input: { amountPaise: number; currency: string }) {
    const order = { id: `order_${this.orders.length + 1}`, amount: input.amountPaise, currency: input.currency };
    this.orders.push(order);
    return order;
  }
  async createPlan(input: { amountPaise: number; intervalMonths: number }) {
    const created = { id: `plan_${this.plans.length + 1}`, ...input };
    this.plans.push(created);
    return { id: created.id };
  }
  async createSubscription(input: { startAt: Date | null }) {
    const created = { id: `sub_${this.subscriptions.length + 1}`, startAt: input.startAt, cancelled: false };
    this.subscriptions.push(created);
    return { id: created.id, status: "created" };
  }
  async cancelSubscription(id: string) {
    const s = this.subscriptions.find((x) => x.id === id);
    if (s) s.cancelled = true;
  }
  verifyPayment(orderId: string, paymentId: string, signature: string) {
    return sign(KEY_SECRET, `${orderId}|${paymentId}`) === signature;
  }
  verifySubscription(subscriptionId: string, paymentId: string, signature: string) {
    return sign(KEY_SECRET, `${paymentId}|${subscriptionId}`) === signature;
  }
  verifyWebhook(rawBody: Buffer, signature: string) {
    return sign(WEBHOOK_SECRET, rawBody) === signature;
  }
}

export class FakeBillingMailbox implements Mailer {
  readonly delivers = true;
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage) {
    this.sent.push(message);
  }
}

export const silentLogger = pino({ level: "silent" });

export class InMemoryInvoices implements InvoiceStore {
  readonly rows: InvoiceRecord[] = [];
  private readonly counters = new Map<string, number>();

  async create(invoice: NewInvoice, numberFor: (seq: number) => string, yearKey: string) {
    const existing = this.rows.find((r) => r.orderId === invoice.orderId);
    if (existing) return existing;
    const seq = (this.counters.get(yearKey) ?? 0) + 1;
    this.counters.set(yearKey, seq);
    const record: InvoiceRecord = {
      ...invoice,
      id: nextId(),
      number: numberFor(seq),
      emailedTo: [],
      lastEmailedAt: null,
    };
    this.rows.push(record);
    return record;
  }
  async byId(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async byOrderId(orderId: string) {
    return this.rows.find((r) => r.orderId === orderId) ?? null;
  }
  async numbersFor(orderIds: string[]) {
    return new Map(
      this.rows.filter((r) => orderIds.includes(r.orderId)).map((r) => [r.orderId, { id: r.id, number: r.number }]),
    );
  }
  async markEmailed(id: string, to: string[], at: Date) {
    const r = this.rows.find((x) => x.id === id);
    if (r) Object.assign(r, { emailedTo: [...new Set([...r.emailedTo, ...to])], lastEmailedAt: at });
  }
}

export class InMemoryBillingDetails implements BillingDetailsStore {
  readonly rows = new Map<string, BillingDetails>();
  async get(ndid: string) {
    return this.rows.get(ndid) ?? null;
  }
  async save(ndid: string, details: BillingDetails) {
    this.rows.set(ndid, details);
  }
}

export const testHotel = async (): Promise<HotelInfo> => ({
  hotelName: "Hotel Test",
  hotelEmail: "desk@hotel.test",
  hotelPhone: "9800000000",
  ownerEmail: "owner@hotel.test",
  city: "Jaipur",
  state: "Rajasthan",
  pinCode: "302001",
});

/** The billing port the admin module needs, over in-memory stores. */
export class TestBillingPort {
  static create(now: () => Date = () => new Date()) {
    const catalogue = new InMemoryCatalogue();
    const offers = new InMemoryOffers();
    const payments = new InMemoryPayments();
    const subscriptions = new InMemorySubscriptionBilling();
    const invoiceStore = new InMemoryInvoices();
    const mailbox = new FakeBillingMailbox();
    const zohoStore = new InMemoryZohoStore();
    const zoho = new FakeZohoBooks();
    const activated: string[] = [];
    // the real module over in-memory stores and a fake Zoho; routes aren't mounted, so auth is a stand-in
    const module = new BillingModule({
      logger: silentLogger,
      mailer: mailbox,
      razorpay: {},
      zoho: {
        ZOHO_ACCOUNTS_URL: "https://accounts.zoho.test",
        ZOHO_API_URL: "https://zoho.test",
        ZOHO_WEBHOOK_TOKEN: TEST_ZOHO_WEBHOOK_TOKEN,
      },
      publicUrl: "https://api.eazotel.test",
      consoleUrl: "https://admin.eazotel.test",
      auth: {
        require: () => (_req: unknown, _res: unknown, next: () => void) => next(),
      } as unknown as AuthenticateMiddleware,
      subscriptions,
      afterActivation: async (ndid) => {
        activated.push(ndid);
      },
      recipients: async () => ({ to: ["owner@hotel.test"], hotelName: "Hotel Test" }),
      hotel: testHotel,
      overrides: {
        catalogue,
        offers,
        payments,
        invoices: invoiceStore,
        billingDetails: new InMemoryBillingDetails(),
        gateway: null,
        zohoStore,
        zohoApi: zoho,
        zohoTokenKey: TEST_ZOHO_KEY,
        now,
      },
    });
    return {
      catalogueStore: catalogue,
      offers,
      payments,
      subscriptions,
      invoiceStore,
      mailbox,
      zohoStore,
      zoho,
      activated,
      port: module.port,
    };
  }
}
