import type { PaymentGateway } from "../../../integrations/razorpay/razorpay.client.js";
import type { Logger } from "../../../shared/logger/logger.js";
import type { AutoRenewal, AutoRenewalStatus, SubscriptionBillingPort } from "../../subscriptions/index.js";
import { AUTO_RENEW_YEARS } from "../constants/billing.constants.js";
import {
  AutoRenewUnavailableError,
  BillingNotConfiguredError,
  PaymentSignatureInvalidError,
} from "../errors/billing.errors.js";
import type { PaymentStore } from "../types/billing.types.js";
import { BillingCatalogueService } from "./billing-catalogue.service.js";
import type { BillingNotifier } from "./billing-notifier.js";
import type { InvoiceService } from "./invoice.service.js";
import { CheckoutService, type BillingActor } from "./checkout.service.js";
import type { PeriodActivator } from "./period-activator.js";
import { PriceCalculator } from "./price-calculator.js";
import { PurchasePlanner } from "./purchase-planner.js";

const MIN_LEAD_MS = 60 * 60_000;

/** The parts of a Razorpay subscription webhook billing reads. */
export interface SubscriptionEvent {
  event: string;
  subscriptionId: string;
  notesNdid: string | null;
  payment: { id: string; orderId: string | null; amount: number; method: string | null } | null;
}

export interface AutoRenewStart {
  subscriptionId: string;
  keyId: string;
  amountPaise: number;
  startAt: Date;
  description: string;
}

/**
 * Auto-renew is a Razorpay subscription (a card or UPI AutoPay mandate). The hotel authorises it
 * once; Razorpay charges the renewal price at the end of each period and tells us through the
 * webhook (`subscription.charged`), and we add the period. The amount is fixed when it is set
 * up: a later price change applies after the hotel switches auto-renew off and on again.
 */
export class AutoRenewService {
  constructor(
    private readonly catalogue: BillingCatalogueService,
    private readonly subscriptions: SubscriptionBillingPort,
    private readonly payments: PaymentStore,
    private readonly activator: PeriodActivator,
    private readonly notifier: BillingNotifier,
    private readonly invoices: InvoiceService,
    private readonly gateway: PaymentGateway | null,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enable(actor: BillingActor): Promise<AutoRenewStart> {
    CheckoutService.mustPay(actor);
    if (!this.gateway) throw new BillingNotConfiguredError();
    const now = this.now();
    const [snapshot, plans, apps, settings] = await Promise.all([
      this.subscriptions.snapshot(actor.ndid),
      this.catalogue.plans(),
      this.catalogue.apps(),
      this.catalogue.settings(),
    ]);
    const phase = PurchasePlanner.phase(snapshot, now);
    const terms = PurchasePlanner.currentTerms(snapshot, plans, apps, settings, now);
    if (!snapshot || !terms || (phase !== "active" && phase !== "ending"))
      throw new AutoRenewUnavailableError("Buy a plan first; auto-renew starts from a paid plan.");
    if (snapshot.endDate.getTime() - now.getTime() < MIN_LEAD_MS)
      throw new AutoRenewUnavailableError("Your plan ends too soon to set up auto-renew. Renew it first.");
    const plan = plans.find((p) => p.id === terms.planId);
    if (!plan || !BillingCatalogueService.purchasable(plan, actor.ndid))
      throw new AutoRenewUnavailableError("Your current plan can't renew automatically. Choose a plan to renew.");

    const quote = PriceCalculator.quote({
      settings,
      plan,
      catalogue: apps,
      cycleMonths: terms.cycleMonths,
      addonCodes: terms.addonCodes,
      seats: terms.seats,
      kind: "renew",
      periodStart: snapshot.endDate,
      creditPaise: 0,
      offer: null,
      offerError: null,
    });
    const description = `${plan.name} plan · ${quote.cycleLabel} · auto-renew`;
    const gatewayPlan = await this.gateway.createPlan({
      name: `Eazotel ${description}`,
      amountPaise: quote.renewalPaise,
      currency: quote.currency,
      intervalMonths: terms.cycleMonths,
    });
    const subscription = await this.gateway.createSubscription({
      planId: gatewayPlan.id,
      totalCount: Math.max(1, Math.floor((AUTO_RENEW_YEARS * 12) / terms.cycleMonths)),
      startAt: snapshot.endDate,
      notes: { ndid: actor.ndid },
    });
    // a previous mandate that was never authorised is simply replaced
    await this.subscriptions.setAutoRenewal(
      actor.ndid,
      {
        status: "pending",
        gatewaySubscriptionId: subscription.id,
        gatewayPlanId: gatewayPlan.id,
        amountPaise: quote.renewalPaise,
        terms: CheckoutService.terms(quote),
        startAt: snapshot.endDate,
        createdAt: now,
        updatedAt: now,
      },
      snapshot.autoRenewal?.status === "active",
      now,
    );
    return {
      subscriptionId: subscription.id,
      keyId: this.gateway.keyId,
      amountPaise: quote.renewalPaise,
      startAt: snapshot.endDate,
      description,
    };
  }

  /** The browser's result after the hotel authorised the mandate. */
  async confirm(actor: BillingActor, paid: { subscriptionId: string; paymentId: string; signature: string }): Promise<void> {
    if (!this.gateway) throw new BillingNotConfiguredError();
    const snapshot = await this.subscriptions.snapshot(actor.ndid);
    const renewal = snapshot?.autoRenewal;
    if (!renewal || renewal.gatewaySubscriptionId !== paid.subscriptionId) throw new PaymentSignatureInvalidError();
    if (!this.gateway.verifySubscription(paid.subscriptionId, paid.paymentId, paid.signature))
      throw new PaymentSignatureInvalidError();
    await this.setStatus(actor.ndid, renewal, "active");
  }

  async disable(actor: BillingActor): Promise<void> {
    CheckoutService.mustPay(actor);
    const snapshot = await this.subscriptions.snapshot(actor.ndid);
    const renewal = snapshot?.autoRenewal;
    if (!renewal) {
      if (snapshot?.autoRenew) await this.subscriptions.setAutoRenewal(actor.ndid, null, false, this.now());
      return;
    }
    if ((renewal.status === "pending" || renewal.status === "active") && this.gateway) {
      try {
        await this.gateway.cancelSubscription(renewal.gatewaySubscriptionId);
      } catch (error) {
        // already cancelled or never authorised at Razorpay: nothing left to stop
        this.logger.warn({ err: error, ndid: actor.ndid }, "auto-renew cancel at Razorpay failed");
      }
    }
    await this.setStatus(actor.ndid, renewal, "cancelled");
  }

  /** subscription.* webhooks. */
  async onEvent(event: SubscriptionEvent): Promise<void> {
    const ndid = event.notesNdid ?? (await this.subscriptions.findNdidByAutoRenewal(event.subscriptionId));
    if (!ndid) return;
    const snapshot = await this.subscriptions.snapshot(ndid);
    const renewal = snapshot?.autoRenewal;
    if (!renewal || renewal.gatewaySubscriptionId !== event.subscriptionId) return;

    switch (event.event) {
      case "subscription.authenticated":
      case "subscription.activated":
      case "subscription.resumed":
        if (renewal.status !== "cancelled") await this.setStatus(ndid, renewal, "active");
        return;
      case "subscription.charged":
        if (event.payment) await this.charged(ndid, renewal, event.payment);
        return;
      case "subscription.halted":
      case "subscription.paused":
        await this.setStatus(ndid, renewal, "halted");
        return;
      case "subscription.cancelled":
      case "subscription.completed":
        await this.setStatus(ndid, renewal, "cancelled");
        return;
      default:
        return;
    }
  }

  private async charged(
    ndid: string,
    renewal: AutoRenewal,
    payment: NonNullable<SubscriptionEvent["payment"]>,
  ): Promise<void> {
    const now = this.now();
    const settings = await this.catalogue.settings();
    const orderId = payment.orderId ?? `sub_${payment.id}`;
    const recorded = await this.payments.insertApplied(
      {
        ndid,
        orderId,
        paymentId: payment.id,
        planId: renewal.terms.planId,
        amount: payment.amount,
        currency: settings.currency,
        status: "SUCCESS",
        method: payment.method,
        paidAt: now,
        createdAt: now,
        source: "gian-new",
        kind: "auto_renew",
        terms: renewal.terms,
        quote: null,
        offerCode: null,
        periodStart: null,
        periodEnd: null,
        autoRenewRequested: true,
        createdBy: "auto-renew",
      },
      now,
    );
    if (!recorded) return; // Razorpay sent this charge before
    const activation = await this.activator.apply(
      {
        ndid,
        terms: renewal.terms,
        kind: "auto_renew",
        netPaise: Math.round(payment.amount / (1 + settings.gstPercent / 100)),
        paymentRef: `auto-renew:${payment.id}`,
        orderId,
        paymentId: payment.id,
      },
      now,
    );
    await this.setStatus(ndid, renewal, "active");
    this.logger.info({ ndid, paymentId: payment.id, until: activation.periodEnd }, "plan auto-renewed");
    const plan = await this.catalogue.plan(renewal.terms.planId);
    await this.notifier.paymentReceived({
      invoice: await this.invoices.issueQuietly(orderId),
      ndid,
      planName: plan?.name ?? renewal.terms.planCode,
      cycleMonths: renewal.terms.cycleMonths,
      amountPaise: payment.amount,
      paymentId: payment.id,
      periodEnd: activation.periodEnd,
      autoRenew: true,
    });
  }

  private async setStatus(ndid: string, renewal: AutoRenewal, status: AutoRenewalStatus): Promise<void> {
    const now = this.now();
    await this.subscriptions.setAutoRenewal(ndid, { ...renewal, status, updatedAt: now }, status === "active", now);
  }
}
