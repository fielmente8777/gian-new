import type { Router } from "express";

import type { Mailer } from "../../integrations/mail/mailer.js";
import type { RazorpayConfig } from "../../integrations/razorpay/razorpay.config.js";
import { RazorpayClient, type PaymentGateway } from "../../integrations/razorpay/razorpay.client.js";
import { ZohoBooksClient, type ZohoBooksApi } from "../../integrations/zoho/zoho-books.client.js";
import type { ZohoConfig } from "../../integrations/zoho/zoho.config.js";
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
import { TokenCipher } from "./services/token-cipher.js";
import { ZohoConnectionService } from "./services/zoho-connection.service.js";
import { ZohoCustomersService } from "./services/zoho-customers.service.js";
import { ZohoInvoicingService } from "./services/zoho-invoicing.service.js";
import { ZohoPoller } from "./services/zoho-poller.js";
import { ZohoSyncService } from "./services/zoho-sync.service.js";
import { ZohoRepository } from "./repositories/zoho.repository.js";
import type { ZohoStore } from "./types/zoho.types.js";
import type {
  BillingDetailsStore,
  CatalogueStore,
  InvoiceStore,
  OfferStore,
  PaymentStore,
} from "./types/billing.types.js";

export interface BillingModuleDeps {
  logger: Logger;
  mailer: Mailer;
  razorpay: RazorpayConfig;
  /** Zoho Books; left out (tests, scripts) = not set up */
  zoho?: ZohoConfig;
  /** this API's public URL, for Zoho's sign-in callback */
  publicUrl?: string;
  /** the admin console's URL: Zoho's sign-in sends staff back there */
  consoleUrl?: string;
  /** false in tests and scripts: no 30-minute Zoho check */
  schedule?: boolean;
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
    zohoStore?: ZohoStore;
    zohoApi?: ZohoBooksApi | null;
    /** base64 32-byte key for the stored Zoho refresh token */
    zohoTokenKey?: string;
    now?: () => Date;
  };
}

/** What the admin module uses: the catalogue to edit, the reports to show and Zoho Books. */
export interface BillingPort {
  catalogue: BillingCatalogueService;
  reports: BillingReportsService;
  invoices: InvoiceService;
  /** staff make Zoho invoices for a client with the same prices as the dashboard */
  checkout: CheckoutService;
  zoho: { connection: ZohoConnectionService; customers: ZohoCustomersService; sync: ZohoSyncService };
}

/**
 * Plans, prices, offers and payments for hotels. See the README in this folder.
 * Owns: `billing_settings`, `billing_offers`, `billing_invoices`, `billing_counters`, `billing_profiles`; writes `plans`, `apps`, `payments` (shared with gian).
 */
export class BillingModule implements AppModule {
  readonly name = "billing";
  readonly router: Router;
  readonly port: BillingPort;

  private readonly stores: {
    offers: OfferStore;
    payments: PaymentStore;
    invoices: InvoiceStore;
    details: BillingDetailsStore;
    zoho: ZohoStore;
  };
  private readonly zohoPoller: ZohoPoller | null;

  constructor(deps: BillingModuleDeps) {
    const { logger, overrides = {} } = deps;
    const now = overrides.now ?? (() => new Date());
    const catalogueStore = overrides.catalogue ?? new CatalogueRepository();
    this.stores = {
      offers: overrides.offers ?? new OfferRepository(),
      payments: overrides.payments ?? new PaymentRepository(),
      invoices: overrides.invoices ?? new InvoiceRepository(),
      details: overrides.billingDetails ?? new BillingDetailsRepository(),
      zoho: overrides.zohoStore ?? new ZohoRepository(),
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

    // Zoho Books: a second way to pay, switched on from the admin console
    const zohoConfig = deps.zoho;
    const zohoApi =
      overrides.zohoApi !== undefined
        ? overrides.zohoApi
        : zohoConfig?.ZOHO_CLIENT_ID && zohoConfig.ZOHO_CLIENT_SECRET
          ? new ZohoBooksClient({
              clientId: zohoConfig.ZOHO_CLIENT_ID,
              clientSecret: zohoConfig.ZOHO_CLIENT_SECRET,
              accountsUrl: zohoConfig.ZOHO_ACCOUNTS_URL,
              apiUrl: zohoConfig.ZOHO_API_URL,
            })
          : null;
    const tokenKey = overrides.zohoTokenKey ?? zohoConfig?.ZOHO_TOKEN_KEY;
    const cipher = tokenKey ? new TokenCipher(tokenKey) : null;
    const publicUrl = (deps.publicUrl ?? "http://localhost:4000").replace(/\/+$/, "");
    const zohoConnection = new ZohoConnectionService(
      this.stores.zoho,
      zohoApi,
      cipher,
      `${publicUrl}/api/v1/billing/zoho/callback`,
      deps.consoleUrl ?? "https://admin.eazotel.com",
      Boolean(zohoConfig?.ZOHO_WEBHOOK_TOKEN),
      logger,
      now,
    );
    const zohoInvoicing = new ZohoInvoicingService(
      zohoConnection,
      zohoApi,
      this.stores.zoho,
      deps.hotel,
      this.stores.details,
      logger,
      now,
    );
    const zohoConnected = async () => zohoConnection.configured && (await this.stores.zoho.connection()) !== null;
    const zohoStore = this.stores.zoho;
    // Zoho not set up on this server: hotels pay by Razorpay whatever was saved before
    const provider = async () => (zohoConnection.configured ? zohoConnection.provider() : ("razorpay" as const));
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
      {
        provider,
        connected: zohoConnected,
        invoicing: zohoInvoicing,
        invoicesFor: async (orderIds) => {
          const found = new Map<string, { number: string; url: string | null }>();
          for (const orderId of orderIds.filter((id) => id.startsWith("zinv_") || id.startsWith("zoho_"))) {
            const invoice = await zohoStore.invoiceByOrder(orderId);
            if (invoice) found.set(orderId, { number: invoice.number, url: invoice.invoiceUrl });
          }
          return found;
        },
      },
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
      provider,
    );
    const webhook = new BillingWebhookService(gateway, checkout, autoRenew, logger);
    const zohoSync = new ZohoSyncService(
      this.stores.zoho,
      zohoConnection,
      zohoApi,
      this.stores.payments,
      (orderId, paid) => checkout.applyPaid(orderId, paid),
      activator,
      catalogue,
      deps.subscriptions,
      zohoConfig?.ZOHO_WEBHOOK_TOKEN ?? null,
      logger,
      now,
    );
    const zohoCustomers = new ZohoCustomersService(zohoConnection, zohoApi, this.stores.zoho, zohoInvoicing, now);
    this.zohoPoller = deps.schedule ? new ZohoPoller(zohoSync, zohoConnected, logger) : null;

    this.port = {
      catalogue,
      reports: new BillingReportsService(this.stores.payments, deps.subscriptions, now),
      invoices,
      checkout,
      zoho: { connection: zohoConnection, customers: zohoCustomers, sync: zohoSync },
    };
    this.router = new BillingRoutes(
      new BillingController(catalogue, checkout, autoRenew, webhook, invoices, zohoConnection, zohoSync),
      deps.auth,
    ).router;
  }

  async init(): Promise<void> {
    const { offers, payments, invoices, details } = this.stores;
    if (invoices instanceof InvoiceRepository) await invoices.ensureIndexes();
    if (details instanceof BillingDetailsRepository) await details.ensureIndexes();
    if (offers instanceof OfferRepository) await offers.ensureIndexes();
    if (payments instanceof PaymentRepository) await payments.ensureIndexes();
    if (this.stores.zoho instanceof ZohoRepository) await this.stores.zoho.ensureIndexes();
    this.zohoPoller?.start();
  }

  async shutdown(): Promise<void> {
    this.zohoPoller?.stop();
  }
}
