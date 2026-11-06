import type { Router } from "express";

import type { Mailer } from "../../integrations/mail/mailer.js";
import type { RazorpayConfig } from "../../integrations/razorpay/razorpay.config.js";
import { RazorpayClient, type PaymentGateway } from "../../integrations/razorpay/razorpay.client.js";
import type { Logger } from "../../shared/logger/logger.js";
import type { AppModule } from "../../shared/module/app-module.js";
import type { AuthenticateMiddleware } from "../auth/index.js";
import type { SubscriptionBillingPort } from "../subscriptions/index.js";
import { BillingController } from "./controllers/billing.controller.js";
import { BillingDetailsRepository } from "./repositories/billing-details.repository.js";
import { CatalogueRepository } from "./repositories/catalogue.repository.js";
import { InvoiceRepository } from "./repositories/invoice.repository.js";
import { OfferRepository } from "./repositories/offer.repository.js";
import { PaymentRepository } from "./repositories/payment.repository.js";
import { BillingRoutes } from "./routes/billing.routes.js";
import { AutoRenewService } from "./services/auto-renew.service.js";
import { BillingCatalogueService } from "./services/billing-catalogue.service.js";
import { BillingNotifier, type BillingRecipients } from "./services/billing-notifier.js";
import { BillingReportsService } from "./services/billing-reports.service.js";
import { BillingWebhookService } from "./services/billing-webhook.service.js";
import { CheckoutService } from "./services/checkout.service.js";
import { InvoiceService, type HotelLookup } from "./services/invoice.service.js";
import { PeriodActivator, type AfterActivation } from "./services/period-activator.js";
import type { BillingDetailsStore, CatalogueStore, InvoiceStore, OfferStore, PaymentStore } from "./types/billing.types.js";

export interface BillingModuleDeps {
  logger: Logger;
  mailer: Mailer;
  razorpay: RazorpayConfig;
  /** the auth module's guard: hotel routes take the dashboard's token */
  auth: AuthenticateMiddleware;
  subscriptions: SubscriptionBillingPort;
  /** runs after a period is applied (client-services: services on, held leads released) */
  afterActivation: AfterActivation;
  /** who gets receipts */
  recipients: BillingRecipients;
  /** the hotel's name, emails and address (profiles + users), for checkout and invoices */
  hotel: HotelLookup;
  /** Tests replace the Mongo stores and Razorpay. */
  overrides?: {
    catalogue?: CatalogueStore;
    offers?: OfferStore;
    payments?: PaymentStore;
    invoices?: InvoiceStore;
    billingDetails?: BillingDetailsStore;
    gateway?: PaymentGateway | null;
    now?: () => Date;
  };
}

/** What the admin module uses: the catalogue to edit and the reports to show. */
export interface BillingPort {
  catalogue: BillingCatalogueService;
  reports: BillingReportsService;
  invoices: InvoiceService;
}

/**
 * Plans, prices, offers and payments for hotels. See the README in this folder.
 * Owns: `billing_settings`, `billing_offers`, `billing_invoices`, `billing_counters`, `billing_profiles`; writes `plans`, `apps`, `payments` (shared with gian).
 */
export class BillingModule implements AppModule {
  readonly name = "billing";
  readonly router: Router;
  readonly port: BillingPort;

  private readonly stores: { offers: OfferStore; payments: PaymentStore; invoices: InvoiceStore; details: BillingDetailsStore };

  constructor(deps: BillingModuleDeps) {
    const { logger, overrides = {} } = deps;
    const now = overrides.now ?? (() => new Date());
    const catalogueStore = overrides.catalogue ?? new CatalogueRepository();
    this.stores = {
      offers: overrides.offers ?? new OfferRepository(),
      payments: overrides.payments ?? new PaymentRepository(),
      invoices: overrides.invoices ?? new InvoiceRepository(),
      details: overrides.billingDetails ?? new BillingDetailsRepository(),
    };
    const gateway = overrides.gateway !== undefined ? overrides.gateway : RazorpayClient.fromConfig(deps.razorpay);
    if (!gateway) logger.warn("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set: online payments are off");

    const catalogue = new BillingCatalogueService(catalogueStore, this.stores.offers, now);
    const notifier = new BillingNotifier(deps.mailer, deps.recipients, logger);
    const invoices = new InvoiceService(
      this.stores.invoices,
      this.stores.details,
      catalogue,
      this.stores.payments,
      deps.hotel,
      deps.mailer,
      logger,
      now,
    );
    const activator = new PeriodActivator(catalogueStore, deps.subscriptions, deps.afterActivation, logger);
    const checkout = new CheckoutService(
      catalogue,
      this.stores.offers,
      this.stores.payments,
      deps.subscriptions,
      activator,
      notifier,
      invoices,
      gateway,
      async (ndid) => (await deps.hotel(ndid)).hotelName,
      logger,
      now,
    );
    const autoRenew = new AutoRenewService(
      catalogue,
      deps.subscriptions,
      this.stores.payments,
      activator,
      notifier,
      invoices,
      gateway,
      logger,
      now,
    );
    const webhook = new BillingWebhookService(gateway, checkout, autoRenew, logger);

    this.port = { catalogue, reports: new BillingReportsService(this.stores.payments, deps.subscriptions, now), invoices };
    this.router = new BillingRoutes(new BillingController(catalogue, checkout, autoRenew, webhook, invoices), deps.auth).router;
  }

  async init(): Promise<void> {
    const { offers, payments, invoices, details } = this.stores;
    if (invoices instanceof InvoiceRepository) await invoices.ensureIndexes();
    if (details instanceof BillingDetailsRepository) await details.ensureIndexes();
    if (offers instanceof OfferRepository) await offers.ensureIndexes();
    if (payments instanceof PaymentRepository) await payments.ensureIndexes();
  }
}
