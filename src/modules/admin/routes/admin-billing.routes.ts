import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminBillingController } from "../controllers/admin-billing.controller.js";
import {
  adminCatalogueSchema,
  billingOverviewSchema,
  BillingSettingsDto,
  catalogueItemSchema,
  CreateAppDto,
  CreateOfferDto,
  CreatePlanDto,
  EmailInvoiceDto,
  IdParamsDto,
  invoiceSummarySchema,
  OrderParamsDto,
  PaymentListQueryDto,
  paymentPageSchema,
  UpdateAppDto,
  UpdateOfferDto,
  UpdatePlanDto,
} from "../dtos/admin-billing.dto.js";
import type { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";

const ITEM = { schema: catalogueItemSchema };

/**
 * /api/v1/admin/billing/*. billing.view: revenue and payments. billing.manage: plans, prices,
 * add-on apps, cycles, GST and offers. Both are advanced permissions (super admins have them).
 */
export class AdminBillingRoutes extends BaseRoutes {
  constructor(c: AdminBillingController, auth: AdminAuthenticateMiddleware) {
    super("/admin/billing", { tag: "Admin billing" });
    const view = auth.require("billing.view");
    const manage = auth.require("billing.manage");

    this.get("/overview", { summary: "Revenue and subscription counts", response: { schema: billingOverviewSchema } }, view, c.overview);
    this.get(
      "/payments",
      {
        summary: "Every payment, newest first",
        description: "Admins with assigned properties see only those clients' payments.",
        query: PaymentListQueryDto,
        response: { schema: paymentPageSchema },
      },
      view,
      c.payments,
    );
    this.get(
      "/invoices/:id",
      { summary: "An invoice, who it was sent to and the suggested recipients", params: IdParamsDto, response: { schema: invoiceSummarySchema }, errors: { 404: "INVOICE_NOT_FOUND" } },
      view,
      c.invoice,
    );
    this.get(
      "/invoices/:id/pdf",
      { summary: "Download an invoice (PDF)", params: IdParamsDto, envelope: false, response: { description: "application/pdf" }, errors: { 404: "INVOICE_NOT_FOUND" } },
      view,
      c.invoicePdf,
    );
    this.post(
      "/invoices/:id/email",
      {
        summary: "Email an invoice (PDF attached)",
        description: "To the addresses given, or the hotel's invoice email, hotel email and owner. Logged.",
        params: IdParamsDto,
        body: EmailInvoiceDto,
        response: { schema: invoiceSummarySchema },
        errors: { 404: "INVOICE_NOT_FOUND" },
      },
      view,
      c.emailInvoice,
    );
    this.post(
      "/payments/:orderId/invoice",
      {
        summary: "Create the invoice for a paid payment that has none",
        description: "For payments from gian's older checkout. New payments get one automatically. Logged.",
        params: OrderParamsDto,
        response: { status: 201, schema: invoiceSummarySchema },
        errors: { 400: "PAYMENT_NOT_PAID", 404: "INVOICE_NOT_FOUND" },
      },
      manage,
      c.createInvoice,
    );
    this.get(
      "/catalogue",
      { summary: "Plans, apps, settings and offers (archived and private ones too)", response: { schema: adminCatalogueSchema } },
      view,
      c.catalogue,
    );

    this.post(
      "/plans",
      { summary: "Create a plan", body: CreatePlanDto, response: { status: 201, ...ITEM }, errors: { 409: "PLAN_CODE_TAKEN", 400: "UNKNOWN_APP_CODES" } },
      manage,
      c.createPlan,
    );
    this.patch(
      "/plans/:id",
      {
        summary: "Change a plan (price, apps, limits, visibility…)",
        description:
          "Applies to purchases and renewals from now on. Hotels keep what they already paid for; auto-renew " +
          "mandates keep their amount. isActive false archives it. Logged.",
        params: IdParamsDto,
        body: UpdatePlanDto,
        response: ITEM,
        errors: { 404: "PLAN_NOT_FOUND", 409: "PLAN_CODE_TAKEN", 400: "UNKNOWN_APP_CODES" },
      },
      manage,
      c.updatePlan,
    );
    this.post(
      "/apps",
      {
        summary: "Add an app to the catalogue",
        description: "The dashboard only knows how to lock existing app codes; a new code needs a dashboard change too.",
        body: CreateAppDto,
        response: { status: 201, ...ITEM },
        errors: { 409: "APP_CODE_TAKEN" },
      },
      manage,
      c.createApp,
    );
    this.patch(
      "/apps/:id",
      { summary: "Change an app's name, description, price or availability", params: IdParamsDto, body: UpdateAppDto, response: ITEM, errors: { 404: "APP_NOT_FOUND" } },
      manage,
      c.updateApp,
    );
    this.put(
      "/settings",
      { summary: "Billing cycles and discounts, GST, seat price, trial days", body: BillingSettingsDto, response: ITEM },
      manage,
      c.saveSettings,
    );
    this.post(
      "/offers",
      { summary: "Create an offer code", body: CreateOfferDto, response: { status: 201, ...ITEM }, errors: { 409: "OFFER_CODE_TAKEN" } },
      manage,
      c.createOffer,
    );
    this.patch(
      "/offers/:id",
      { summary: "Change or switch off an offer", params: IdParamsDto, body: UpdateOfferDto, response: ITEM, errors: { 404: "OFFER_NOT_FOUND", 409: "OFFER_CODE_TAKEN" } },
      manage,
      c.updateOffer,
    );
  }
}
