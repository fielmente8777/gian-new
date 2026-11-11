import { Types } from "mongoose";

import type { PaymentGateway } from "../../../integrations/razorpay/razorpay.client.js";
import type { Logger } from "../../../shared/logger/logger.js";
import type { PurchaseTerms, SubscriptionBillingPort } from "../../subscriptions/index.js";
import {
  BillingNotConfiguredError,
  BillingOwnerOnlyError,
  OfferInvalidError,
  OrderNotFoundError,
  PaymentSignatureInvalidError,
  PlanNotAvailableError,
  PriceChangedError,
} from "../errors/billing.errors.js";
import type {
  CataloguePlan,
  Offer,
  OfferStore,
  PaymentRecord,
  PaymentStore,
  PurchaseChoice,
  Quote,
} from "../types/billing.types.js";
import { BillingCatalogueService, type PublicCatalogue } from "./billing-catalogue.service.js";
import { BillingDates } from "./billing-dates.js";
import type { BillingNotifier } from "./billing-notifier.js";
import type { InvoiceService } from "./invoice.service.js";
import { OfferRules } from "./offer-rules.js";
import type { PeriodActivator } from "./period-activator.js";
import { PriceCalculator } from "./price-calculator.js";
import { PurchasePlanner, type BillingPhase } from "./purchase-planner.js";
import type { PaymentProvider } from "../types/zoho.types.js";
import type { ZohoInvoicingService } from "./zoho-invoicing.service.js";

/** What checkout needs to take a payment by Zoho Books invoice instead of Razorpay. */
export interface ZohoCheckout {
  provider(): Promise<PaymentProvider>;
  connected(): Promise<boolean>;
  invoicing: Pick<ZohoInvoicingService, "invoiceForQuote">;
  /** Zoho invoice number and link per payment, for the payments list */
  invoicesFor(orderIds: string[]): Promise<Map<string, { number: string; url: string | null }>>;
}

/** Who is asking: the hotel account from the token. */
export interface BillingActor {
  ndid: string;
  email: string;
  /** the account owner (or an account admin) */
  isAdmin: boolean;
  /** an Eazotel staff member who opened this account from the admin console */
  staffEmail: string | null;
}

/** Everything the dashboard's plans and subscription pages need, in one answer. */
export interface BillingAccount {
  phase: BillingPhase;
  subscription: {
    planId: string | null;
    planCode: string | null;
    planName: string | null;
    startDate: Date;
    endDate: Date;
    daysLeft: number;
    autoRenew: boolean;
    autoRenewal: { status: string; amountPaise: number; startAt: Date; cycleMonths: number } | null;
    stoppedBy: "paused" | "expired" | null;
  } | null;
  /** what the hotel pays for now; null on the trial */
  current: PurchaseTerms | null;
  /** apps on in the dashboard now, and the limits that come with the plan */
  entitlements: {
    apps: string[];
    teamMembers: number;
    properties: number;
    aiCreditsMonthly: number;
    maxLeadsPerMonth: number;
  };
  catalogue: PublicCatalogue;
  payments: (Pick<
    PaymentRecord,
    | "id"
    | "orderId"
    | "paymentId"
    | "amount"
    | "currency"
    | "status"
    | "kind"
    | "paidAt"
    | "createdAt"
    | "periodStart"
    | "periodEnd"
    | "offerCode"
  > & {
    /** the GST invoice, once issued */
    invoice: { id: string; number: string } | null;
    /** a Zoho Books invoice for this payment: its number and the page to see or pay it */
    zohoInvoice: { number: string; url: string | null } | null;
  })[];
  canPay: boolean;
  paymentsReady: boolean;
  autoRenewReady: boolean;
  /** razorpay: pay in the dashboard; zoho: pay the Zoho Books invoice checkout opens */
  paymentProvider: PaymentProvider;
}

export interface CheckoutRequest extends PurchaseChoice {
  /** ask for auto-renew once this payment is through */
  autoRenew: boolean;
  /** the total the hotel saw; a different server total answers 409 PRICE_CHANGED */
  expectedTotalPaise?: number;
}

export type CheckoutStart =
  | {
      status: "pending";
      orderId: string;
      amountPaise: number;
      currency: string;
      keyId: string;
      description: string;
      prefill: { name: string | null; email: string };
      quote: Quote;
    }
  | { status: "applied"; account: BillingAccount }
  | {
      /** a Zoho Books invoice was made: open `invoiceUrl` to pay; the plan renews once Zoho says it's paid */
      status: "invoice";
      orderId: string;
      invoiceId: string;
      invoiceNumber: string;
      invoiceUrl: string | null;
      totalPaise: number;
      quote: Quote;
    };

/**
 * Prices and takes payments for plans: quote → Razorpay order → the browser pays → we verify
 * the signature (or the webhook tells us) → the period is applied once.
 * Amounts always come from the server's own quote; the browser only says what it picked.
 */
export class CheckoutService {
  constructor(
    private readonly catalogue: BillingCatalogueService,
    private readonly offers: OfferStore,
    private readonly payments: PaymentStore,
    private readonly subscriptions: SubscriptionBillingPort,
    private readonly activator: PeriodActivator,
    private readonly notifier: BillingNotifier,
    private readonly invoices: InvoiceService,
    private readonly gateway: PaymentGateway | null,
    private readonly hotelName: (ndid: string) => Promise<string | null>,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
    private readonly zoho: ZohoCheckout | null = null,
  ) {}

  async account(actor: BillingActor): Promise<BillingAccount> {
    const now = this.now();
    const [snapshot, catalogue, plans, apps, settings, payments] = await Promise.all([
      this.subscriptions.snapshot(actor.ndid),
      this.catalogue.publicCatalogue(actor.ndid),
      this.catalogue.plans(),
      this.catalogue.apps(),
      this.catalogue.settings(),
      this.payments.list({ page: 1, pageSize: 25, ndid: actor.ndid }),
    ]);
    const orderIds = payments.items.map((p) => p.orderId);
    const [invoiceNumbers, zohoInvoices, provider, zohoConnected] = await Promise.all([
      this.invoices.numbersFor(orderIds),
      this.zoho ? this.zoho.invoicesFor(orderIds) : new Map<string, { number: string; url: string | null }>(),
      this.paymentProvider(),
      this.zoho ? this.zoho.connected() : false,
    ]);
    const phase = PurchasePlanner.phase(snapshot, now);
    const plan = snapshot?.planId ? (plans.find((p) => p.id === snapshot.planId) ?? null) : null;
    const current = PurchasePlanner.currentTerms(snapshot, plans, apps, settings, now);
    const serving = phase !== "ended" && phase !== "stopped" && phase !== "none";
    const enabledApps = serving ? apps.filter((a) => snapshot?.appAccess[a.code] === true).map((a) => a.code) : [];

    return {
      phase,
      subscription: snapshot
        ? {
            planId: snapshot.planId,
            planCode: plan?.code ?? null,
            planName: phase === "trial" ? "Free trial" : (plan?.name ?? null),
            startDate: snapshot.startDate,
            endDate: snapshot.endDate,
            daysLeft: BillingDates.daysBetween(now, snapshot.endDate),
            autoRenew: snapshot.autoRenew,
            autoRenewal: snapshot.autoRenewal
              ? {
                  status: snapshot.autoRenewal.status,
                  amountPaise: snapshot.autoRenewal.amountPaise,
                  startAt: snapshot.autoRenewal.startAt,
                  cycleMonths: snapshot.autoRenewal.terms.cycleMonths,
                }
              : null,
            stoppedBy: snapshot.staffStop?.kind ?? null,
          }
        : null,
      current,
      entitlements: {
        apps: enabledApps,
        teamMembers: (plan?.limits.teamMembers ?? 1) + (current?.seats ?? 0),
        properties: plan?.limits.properties ?? 1,
        aiCreditsMonthly: plan?.limits.aiCreditsMonthly ?? 0,
        maxLeadsPerMonth: plan?.limits.maxLeadsPerMonth ?? -1,
      },
      catalogue,
      payments: payments.items.map((p) => ({
        id: p.id,
        orderId: p.orderId,
        paymentId: p.paymentId,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        kind: p.kind,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        offerCode: p.offerCode,
        invoice: invoiceNumbers.get(p.orderId) ?? null,
        zohoInvoice: zohoInvoices.get(p.orderId) ?? null,
      })),
      canPay: actor.isAdmin || actor.staffEmail !== null,
      paymentsReady: provider === "zoho" ? zohoConnected : this.gateway !== null,
      // a Zoho invoice is paid by hand each time; auto-renew stays a Razorpay mandate
      autoRenewReady: provider === "razorpay" && this.gateway !== null,
      paymentProvider: provider,
    };
  }

  /** Prices a choice. An offer that doesn't apply is reported in `offerError`, not thrown. */
  async quote(actor: BillingActor, choice: PurchaseChoice): Promise<Quote> {
    const now = this.now();
    const [plan, apps, settings, plans, snapshot] = await Promise.all([
      this.catalogue.plan(choice.planId),
      this.catalogue.apps(),
      this.catalogue.settings(),
      this.catalogue.plans(),
      this.subscriptions.snapshot(actor.ndid),
    ]);
    if (!plan || !BillingCatalogueService.purchasable(plan, actor.ndid)) throw new PlanNotAvailableError();
    const addons = PriceCalculator.addons(plan, apps, choice.addonCodes).map((a) => a.code);
    const phase = PurchasePlanner.phase(snapshot, now);
    const current = PurchasePlanner.currentTerms(snapshot, plans, apps, settings, now);
    const kind = PurchasePlanner.kind(phase, current, plan, addons, choice.seats);

    let creditPaise = 0;
    if (kind === "change") {
      const base = PurchasePlanner.creditBase(
        snapshot,
        await this.payments.lastSuccessful(actor.ndid),
        settings.gstPercent,
      );
      if (base) creditPaise = PriceCalculator.unusedValue(base.netPaise, base.start, base.end, now);
    }

    const { offer, offerError } = await this.checkOffer(actor.ndid, choice, plan, kind, now);
    return PriceCalculator.quote({
      settings,
      plan,
      catalogue: apps,
      cycleMonths: choice.cycleMonths,
      addonCodes: addons,
      seats: choice.seats,
      kind,
      periodStart: kind === "renew" && snapshot ? snapshot.endDate : now,
      creditPaise,
      offer,
      offerError,
    });
  }

  /** Creates the Razorpay order for a quote. A total of zero is applied at once. */
  async start(actor: BillingActor, request: CheckoutRequest): Promise<CheckoutStart> {
    CheckoutService.mustPay(actor);
    const quote = await this.quote(actor, request);
    if (quote.offerError) throw new OfferInvalidError(quote.offerError);
    if (request.expectedTotalPaise !== undefined && request.expectedTotalPaise !== quote.totalPaise)
      throw new PriceChangedError();
    const terms = CheckoutService.terms(quote);
    const now = this.now();

    if (quote.totalPaise === 0) {
      const orderId = `free_${new Types.ObjectId().toHexString()}`;
      await this.payments.create(this.newPayment(actor, quote, terms, orderId, request.autoRenew, now));
      await this.applyPaid(orderId, { paymentId: orderId, method: "credit", paidAt: now });
      return { status: "applied", account: await this.account(actor) };
    }

    if ((await this.paymentProvider()) === "zoho") {
      return this.zohoInvoice(actor, quote, terms, [actor.email], now);
    }

    if (!this.gateway) throw new BillingNotConfiguredError();
    const order = await this.gateway.createOrder({
      amountPaise: quote.totalPaise,
      currency: quote.currency,
      receipt: `ez_${actor.ndid.slice(0, 8)}_${now.getTime()}`,
      notes: { ndid: actor.ndid, plan: quote.plan.code, kind: quote.kind, months: String(quote.cycleMonths) },
    });
    await this.payments.create(this.newPayment(actor, quote, terms, order.id, request.autoRenew, now));
    return {
      status: "pending",
      orderId: order.id,
      amountPaise: order.amount,
      currency: order.currency,
      keyId: this.gateway.keyId,
      description: `${quote.plan.name} plan · ${quote.cycleLabel}`,
      prefill: { name: await this.hotelName(actor.ndid), email: actor.email },
      quote,
    };
  }

  /**
   * A Zoho Books invoice for a choice, made by staff from the admin console: works whichever
   * way hotels pay now, so the team can invoice through Zoho during the switch-over. Priced by
   * the same quote as the dashboard. Zoho emails it to `emailTo` when given.
   */
  async zohoInvoiceForStaff(
    actor: BillingActor,
    choice: PurchaseChoice,
    emailTo: string[],
  ): Promise<Extract<CheckoutStart, { status: "invoice" }>> {
    const quote = await this.quote(actor, choice);
    if (quote.offerError) throw new OfferInvalidError(quote.offerError);
    return this.zohoInvoice(actor, quote, CheckoutService.terms(quote), emailTo, this.now());
  }

  private async zohoInvoice(
    actor: BillingActor,
    quote: Quote,
    terms: PurchaseTerms,
    emailTo: string[],
    now: Date,
  ): Promise<Extract<CheckoutStart, { status: "invoice" }>> {
    if (!this.zoho || !(await this.zoho.connected())) throw new BillingNotConfiguredError();
    // our order id goes on the invoice as its reference, so its payment is found again from Zoho
    const orderId = `zinv_${new Types.ObjectId().toHexString()}`;
    await this.payments.create({ ...this.newPayment(actor, quote, terms, orderId, false, now), method: "zoho" });
    const invoice = await this.zoho.invoicing.invoiceForQuote({
      ndid: actor.ndid,
      quote,
      orderId,
      by: actor.staffEmail ?? actor.email,
      emailTo,
    });
    return {
      status: "invoice",
      orderId,
      invoiceId: invoice.invoiceId,
      invoiceNumber: invoice.number,
      invoiceUrl: invoice.invoiceUrl,
      totalPaise: invoice.totalPaise,
      quote,
    };
  }

  private async paymentProvider(): Promise<PaymentProvider> {
    return this.zoho ? this.zoho.provider() : "razorpay";
  }

  /** The browser's Razorpay handler result: verified, then applied (once, even if the webhook was first). */
  async confirm(
    actor: BillingActor,
    paid: { orderId: string; paymentId: string; signature: string },
  ): Promise<{ account: BillingAccount; autoRenewRequested: boolean }> {
    if (!this.gateway) throw new BillingNotConfiguredError();
    const payment = await this.payments.findByOrderId(paid.orderId);
    if (!payment || payment.ndid !== actor.ndid || payment.source !== "gian-new") throw new OrderNotFoundError();
    if (!this.gateway.verifyPayment(paid.orderId, paid.paymentId, paid.signature))
      throw new PaymentSignatureInvalidError();
    await this.applyPaid(paid.orderId, { paymentId: paid.paymentId, method: null, paidAt: this.now() });
    return { account: await this.account(actor), autoRenewRequested: payment.autoRenewRequested };
  }

  /** Applies a paid order. Safe to call any number of times: only the first call does anything. */
  async applyPaid(orderId: string, paid: { paymentId: string; method: string | null; paidAt: Date }): Promise<boolean> {
    const now = this.now();
    const payment = await this.payments.claim(orderId, paid, now);
    if (!payment || !payment.terms || !payment.quote) return false;
    const quote = payment.quote;
    const activation = await this.activator.apply(
      {
        ndid: payment.ndid,
        terms: payment.terms,
        kind: quote.kind,
        // the period's value: what was paid before GST plus the credit carried over
        netPaise: quote.taxablePaise + quote.creditPaise,
        paymentRef: orderId,
        orderId,
        paymentId: paid.paymentId,
        bonusDays: quote.bonusDays ?? 0,
      },
      now,
    );
    await this.payments.markApplied(orderId, now);
    if (payment.offerCode) await this.offers.redeem(payment.offerCode);
    this.logger.info({ ndid: payment.ndid, orderId, kind: quote.kind, amount: payment.amount }, "plan payment applied");
    if (payment.amount > 0) {
      // a Zoho payment already has its GST invoice, in Zoho Books
      const invoice =
        payment.method === "zoho" || orderId.startsWith("zinv_") ? null : await this.invoices.issueQuietly(orderId);
      await this.notifier.paymentReceived({
        invoice,
        ndid: payment.ndid,
        planName: quote.plan.name,
        cycleMonths: quote.cycleMonths,
        amountPaise: payment.amount,
        paymentId: paid.paymentId,
        periodEnd: activation.periodEnd,
        autoRenew: false,
      });
    }
    return true;
  }

  async failed(orderId: string, reason: string, paymentId: string | null): Promise<void> {
    const payment = await this.payments.findByOrderId(orderId);
    if (payment?.source === "gian-new") await this.payments.markFailed(orderId, reason, paymentId);
  }

  static mustPay(actor: BillingActor): void {
    if (!actor.isAdmin && !actor.staffEmail) throw new BillingOwnerOnlyError();
  }

  static terms(quote: Quote): PurchaseTerms {
    return {
      planId: quote.plan.id,
      planCode: quote.plan.code,
      cycleMonths: quote.cycleMonths,
      addonCodes: quote.addonCodes,
      seats: quote.seats,
    };
  }

  private newPayment(
    actor: BillingActor,
    quote: Quote,
    terms: PurchaseTerms,
    orderId: string,
    autoRenew: boolean,
    now: Date,
  ) {
    return {
      ndid: actor.ndid,
      orderId,
      paymentId: null,
      planId: quote.plan.id,
      amount: quote.totalPaise,
      currency: quote.currency,
      status: "created" as const,
      method: null,
      paidAt: null,
      createdAt: now,
      source: "gian-new",
      kind: quote.kind,
      terms,
      quote,
      offerCode: quote.offer?.code ?? null,
      periodStart: quote.periodStart,
      periodEnd: quote.periodEnd,
      autoRenewRequested: autoRenew,
      createdBy: actor.staffEmail ?? actor.email,
    };
  }

  private async checkOffer(
    ndid: string,
    choice: PurchaseChoice,
    plan: CataloguePlan,
    kind: Quote["kind"],
    now: Date,
  ): Promise<{ offer: Offer | null; offerError: string | null }> {
    const code = OfferRules.normalise(choice.offerCode);
    if (!code) return { offer: null, offerError: null };
    const offer = await this.offers.byCode(code);
    const [usesByClient, hasPaidBefore] = offer
      ? await Promise.all([this.payments.offerUses(ndid, code), this.payments.hasPaid(ndid)])
      : [0, false];
    const reason = OfferRules.reject(offer, {
      ndid,
      planCode: plan.code,
      cycleMonths: choice.cycleMonths,
      kind,
      usesByClient,
      hasPaidBefore,
      now,
    });
    return reason ? { offer: null, offerError: reason } : { offer, offerError: null };
  }
}
