import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AuthenticateMiddleware } from "../../auth/index.js";
import type { BillingController } from "../controllers/billing.controller.js";
import {
  accountSchema,
  AutoRenewDto,
  BillingDetailsDto,
  billingDetailsSchema,
  InvoiceParamsDto,
  autoRenewSchema,
  catalogueSchema,
  CheckoutDto,
  checkoutSchema,
  ConfirmAutoRenewDto,
  ConfirmPaymentDto,
  PurchaseChoiceDto,
  quoteSchema,
} from "../dtos/billing.dto.js";

const CHOICE_ERRORS = { 400: "PLAN_NOT_AVAILABLE, CYCLE_NOT_AVAILABLE, APP_NOT_AVAILABLE" };

/**
 * /api/v1/billing/*. Hotel routes take the dashboard's own token (old nexon tokens work too,
 * see the auth module). Staff routes for the same data are under /api/v1/admin/billing.
 */
export class BillingRoutes extends BaseRoutes {
  constructor(c: BillingController, auth: AuthenticateMiddleware) {
    super("/billing", { tag: "Billing" });
    const signedIn = auth.require();

    this.get(
      "/catalogue",
      {
        summary: "Plans, apps, billing cycles and offers (public)",
        description: "What the website's pricing page shows. Prices are rupees per month before GST.",
        response: { schema: catalogueSchema },
      },
      c.publicCatalogue,
    );
    this.get(
      "/account",
      {
        summary: "The hotel's plan, what it can use, the plans it can buy and its payments",
        description: "Everything the dashboard's plans and subscription pages need, in one call.",
        response: { schema: accountSchema },
      },
      signedIn,
      c.account,
    );
    this.post(
      "/quote",
      {
        summary: "Price a plan choice",
        description:
          "kind: new (no paid plan running), renew (same plan, apps and seats: added after the current end) or " +
          "change (starts today, with a credit for the unused part of the current period). An offer that doesn't " +
          "apply is explained in offerError.",
        body: PurchaseChoiceDto,
        response: { schema: quoteSchema },
        errors: CHOICE_ERRORS,
      },
      signedIn,
      c.quote,
    );
    this.post(
      "/checkout",
      {
        summary: "Start paying for a plan choice",
        description:
          "Prices the choice again on the server and creates a Razorpay order for that amount. Open Razorpay " +
          "checkout with the answer, then send its result to /checkout/confirm. A total of 0 (fully covered by " +
          "credit) is applied at once (status applied). Account owners only.",
        body: CheckoutDto,
        response: { schema: checkoutSchema },
        errors: { ...CHOICE_ERRORS, 400: `${CHOICE_ERRORS[400]}, OFFER_INVALID`, 403: "BILLING_OWNER_ONLY", 409: "PRICE_CHANGED", 503: "BILLING_NOT_CONFIGURED" },
      },
      signedIn,
      c.start,
    );
    this.post(
      "/checkout/confirm",
      {
        summary: "Confirm a payment (Razorpay checkout's handler result)",
        description: "Checks Razorpay's signature and applies the plan. Safe to repeat; the webhook does the same.",
        body: ConfirmPaymentDto,
        response: { schema: accountSchema },
        errors: { 400: "PAYMENT_SIGNATURE_INVALID", 404: "ORDER_NOT_FOUND" },
      },
      signedIn,
      c.confirm,
    );
    this.post(
      "/auto-renew",
      {
        summary: "Turn auto-renew on or off",
        description:
          "On: creates a Razorpay subscription for the current plan's renewal price, first charged at the current " +
          "end date. Open Razorpay checkout with subscription_id to authorise it, then call /auto-renew/confirm. " +
          "Off: cancels it at Razorpay.",
        body: AutoRenewDto,
        response: { schema: autoRenewSchema },
        errors: { 403: "BILLING_OWNER_ONLY", 422: "AUTO_RENEW_UNAVAILABLE", 503: "BILLING_NOT_CONFIGURED" },
      },
      signedIn,
      c.setAutoRenew,
    );
    this.post(
      "/auto-renew/confirm",
      {
        summary: "Confirm the auto-renew authorisation",
        body: ConfirmAutoRenewDto,
        response: { schema: accountSchema },
        errors: { 400: "PAYMENT_SIGNATURE_INVALID" },
      },
      signedIn,
      c.confirmAutoRenew,
    );
    this.get(
      "/invoices/:id/pdf",
      {
        summary: "Download an invoice (PDF)",
        description: "One GST invoice per successful payment; the ids are in /account → payments[].invoice.",
        params: InvoiceParamsDto,
        envelope: false,
        response: { description: "application/pdf" },
        errors: { 404: "INVOICE_NOT_FOUND" },
      },
      signedIn,
      c.invoicePdf,
    );
    this.get(
      "/details",
      { summary: "The name, GSTIN and address on the hotel's invoices", response: { schema: billingDetailsSchema } },
      signedIn,
      c.billingDetails,
    );
    this.put(
      "/details",
      {
        summary: "Change the name, GSTIN and address on future invoices",
        description: "Invoices already issued never change. Account owners only.",
        body: BillingDetailsDto,
        response: { schema: billingDetailsSchema },
        errors: { 403: "BILLING_OWNER_ONLY" },
      },
      signedIn,
      c.saveBillingDetails,
    );
    this.post(
      "/webhooks/razorpay",
      {
        summary: "Razorpay webhook",
        description: "Signed with RAZORPAY_WEBHOOK_SECRET (X-Razorpay-Signature over the raw body).",
        validate: false,
        envelope: false,
        errors: { 400: "WEBHOOK_SIGNATURE_INVALID", 503: "WEBHOOK_NOT_CONFIGURED" },
      },
      c.razorpayWebhook,
    );
  }
}
