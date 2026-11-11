import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminZohoController } from "../controllers/admin-zoho.controller.js";
import {
  ZohoApplyDto,
  ZohoCreateInvoiceDto,
  ZohoInvoiceParamsDto,
  ZohoInvoiceStateQueryDto,
  zohoItemSchema,
  ZohoLinkDto,
  zohoListSchema,
  ZohoNdidParamsDto,
  ZohoProviderDto,
  zohoStatusSchema,
  ZohoTaxDto,
} from "../dtos/admin-zoho.dto.js";
import type { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";

const NOT_READY = { 503: "ZOHO_NOT_CONFIGURED", 409: "ZOHO_NOT_CONNECTED" };

/**
 * /api/v1/admin/zoho/*: Zoho Books. billing.view sees the status and invoices; billing.manage
 * connects it, switches where hotels pay, links customers, applies invoices and invoices clients.
 */
export class AdminZohoRoutes extends BaseRoutes {
  constructor(c: AdminZohoController, auth: AdminAuthenticateMiddleware) {
    super("/admin/zoho", { tag: "Admin Zoho Books" });
    const view = auth.require("billing.view");
    const manage = auth.require("billing.manage");

    this.get(
      "/status",
      {
        summary: "Connected or not, the tax, the last sync and where hotels pay",
        response: { schema: zohoStatusSchema },
      },
      view,
      c.status,
    );
    this.post(
      "/connect",
      {
        summary: "Start connecting Zoho Books",
        description:
          "Answers Zoho's sign-in URL; open it in the same browser. Zoho sends it back to the console within 10 minutes.",
        response: { schema: zohoItemSchema },
        errors: { 503: "ZOHO_NOT_CONFIGURED" },
      },
      manage,
      c.connect,
    );
    this.post(
      "/disconnect",
      {
        summary: "Disconnect Zoho Books",
        description: "While hotels pay through Zoho, payments go back to Razorpay. Logged.",
        response: { schema: zohoStatusSchema },
      },
      manage,
      c.disconnect,
    );
    this.get(
      "/taxes",
      { summary: "Zoho Books' taxes, to pick the GST rate", response: { schema: zohoListSchema }, errors: NOT_READY },
      manage,
      c.taxes,
    );
    this.put(
      "/tax",
      {
        summary: "The GST tax put on every Zoho invoice line",
        body: ZohoTaxDto,
        response: { schema: zohoStatusSchema },
        errors: NOT_READY,
      },
      manage,
      c.setTax,
    );
    this.put(
      "/provider",
      {
        summary: "Where hotels pay: Razorpay or Zoho Books",
        description:
          "zoho: the dashboard's pay button makes a Zoho Books invoice at the same price and opens its payment page; the " +
          "plan renews once Zoho says it's paid. Auto-renew can't be switched on meanwhile (existing mandates keep " +
          "charging). razorpay: as before. Needs a connection for zoho. Logged.",
        body: ZohoProviderDto,
        response: { schema: zohoStatusSchema },
        errors: NOT_READY,
      },
      manage,
      c.setProvider,
    );
    this.get(
      "/customers",
      {
        summary: "Every Zoho customer, its client and a guess for unlinked ones",
        response: { schema: zohoListSchema },
        errors: NOT_READY,
      },
      manage,
      c.customers,
    );
    this.put(
      "/links/:ndid",
      {
        summary: "This client is that Zoho customer",
        description: "Replaces either side's earlier link. Logged.",
        params: ZohoNdidParamsDto,
        body: ZohoLinkDto,
        response: { schema: zohoItemSchema },
        errors: { ...NOT_READY, 404: "CLIENT_NOT_FOUND" },
      },
      manage,
      c.link,
    );
    this.delete(
      "/links/:ndid",
      {
        summary: "Untie a client from its Zoho customer",
        params: ZohoNdidParamsDto,
        response: { schema: zohoItemSchema },
        errors: { 404: "CLIENT_NOT_FOUND" },
      },
      manage,
      c.unlink,
    );
    this.post(
      "/links/:ndid/create",
      {
        summary: "Make a Zoho customer from the client's profile and link it",
        params: ZohoNdidParamsDto,
        response: { status: 201, schema: zohoItemSchema },
        errors: { ...NOT_READY, 404: "CLIENT_NOT_FOUND" },
      },
      manage,
      c.createCustomer,
    );
    this.get(
      "/invoices",
      {
        summary: "Zoho invoices: waiting for staff, applied or unpaid",
        query: ZohoInvoiceStateQueryDto,
        response: { schema: zohoListSchema },
      },
      view,
      c.invoices,
    );
    this.post(
      "/invoices/:invoiceId/apply",
      {
        summary: "Renew a client's plan for a paid Zoho invoice",
        description:
          "For invoices made in Zoho Books by hand. Same plan = added after the current end; another plan = starts today. Once only. Logged.",
        params: ZohoInvoiceParamsDto,
        body: ZohoApplyDto,
        response: { schema: zohoItemSchema },
        errors: {
          404: "ZOHO_INVOICE_NOT_FOUND, CLIENT_NOT_FOUND",
          409: "ZOHO_INVOICE_NOT_APPLICABLE",
          400: "PLAN_NOT_AVAILABLE",
        },
      },
      manage,
      c.apply,
    );
    this.post(
      "/invoices/:invoiceId/ignore",
      {
        summary: "Not a subscription payment: take it off the waiting list",
        params: ZohoInvoiceParamsDto,
        response: { schema: zohoItemSchema },
        errors: { 404: "ZOHO_INVOICE_NOT_FOUND" },
      },
      manage,
      c.ignore,
    );
    this.post(
      "/sync",
      {
        summary: "Read Zoho's paid invoices now (also runs every 30 minutes)",
        response: { schema: zohoItemSchema },
        errors: NOT_READY,
      },
      manage,
      c.sync,
    );
    this.post(
      "/clients/:ndid/invoice",
      {
        summary: "Invoice a client through Zoho Books",
        description:
          "Priced like the dashboard. Works whichever way hotels pay now. Zoho emails it to emailTo. Logged.",
        params: ZohoNdidParamsDto,
        body: ZohoCreateInvoiceDto,
        response: { status: 201, schema: zohoItemSchema },
        errors: { ...NOT_READY, 404: "CLIENT_NOT_FOUND", 400: "PLAN_NOT_AVAILABLE, OFFER_INVALID" },
      },
      manage,
      c.createInvoice,
    );
  }
}
