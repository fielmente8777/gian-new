import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
} from "../../../shared/errors/http-errors.js";

// Stable codes: the dashboard and the admin console switch on `code`, never on the message.

export class BillingNotConfiguredError extends ServiceUnavailableError {
  constructor() {
    super("Online payments are not set up yet. Please contact Eazotel support.", { code: "BILLING_NOT_CONFIGURED" });
  }
}

export class BillingOwnerOnlyError extends ForbiddenError {
  constructor() {
    super("Only the account owner can change the plan or pay.", { code: "BILLING_OWNER_ONLY" });
  }
}

export class PlanNotAvailableError extends BadRequestError {
  constructor() {
    super("This plan can't be bought online. Please contact Eazotel.", { code: "PLAN_NOT_AVAILABLE" });
  }
}

export class CycleNotAvailableError extends BadRequestError {
  constructor() {
    super("This billing cycle is not available.", { code: "CYCLE_NOT_AVAILABLE" });
  }
}

export class AppNotAvailableError extends BadRequestError {
  constructor(code: string) {
    super(`The app "${code}" is not available.`, { code: "APP_NOT_AVAILABLE" });
  }
}

export class OfferInvalidError extends BadRequestError {
  constructor(reason: string) {
    super(reason, { code: "OFFER_INVALID" });
  }
}

export class PriceChangedError extends ConflictError {
  constructor() {
    super("The price changed. Please check the new total and pay again.", { code: "PRICE_CHANGED" });
  }
}

export class PaymentSignatureInvalidError extends BadRequestError {
  constructor() {
    super("We could not verify this payment. If money was taken, contact support with the payment ID.", {
      code: "PAYMENT_SIGNATURE_INVALID",
    });
  }
}

export class OrderNotFoundError extends NotFoundError {
  constructor() {
    super("Order not found", { code: "ORDER_NOT_FOUND" });
  }
}

export class AutoRenewUnavailableError extends UnprocessableError {
  constructor(reason: string) {
    super(reason, { code: "AUTO_RENEW_UNAVAILABLE" });
  }
}

export class WebhookSignatureInvalidError extends BadRequestError {
  constructor() {
    super("Invalid webhook signature", { code: "WEBHOOK_SIGNATURE_INVALID" });
  }
}

export class WebhookNotConfiguredError extends ServiceUnavailableError {
  constructor() {
    super("RAZORPAY_WEBHOOK_SECRET is not set", { code: "WEBHOOK_NOT_CONFIGURED" });
  }
}

// ─── catalogue management (admin console) ───────────────────────────────────────────────

export class CataloguePlanNotFoundError extends NotFoundError {
  constructor() {
    super("Plan not found", { code: "PLAN_NOT_FOUND" });
  }
}

export class PlanCodeTakenError extends ConflictError {
  constructor() {
    super("Another plan already uses this code", { code: "PLAN_CODE_TAKEN" });
  }
}

export class CatalogueAppNotFoundError extends NotFoundError {
  constructor() {
    super("App not found", { code: "APP_NOT_FOUND" });
  }
}

export class AppCodeTakenError extends ConflictError {
  constructor() {
    super("Another app already uses this code", { code: "APP_CODE_TAKEN" });
  }
}

export class UnknownAppCodesError extends BadRequestError {
  constructor(codes: string[]) {
    super(`Unknown app codes: ${codes.join(", ")}`, { code: "UNKNOWN_APP_CODES" });
  }
}

export class OfferNotFoundError extends NotFoundError {
  constructor() {
    super("Offer not found", { code: "OFFER_NOT_FOUND" });
  }
}

export class OfferCodeTakenError extends ConflictError {
  constructor() {
    super("Another offer already uses this code", { code: "OFFER_CODE_TAKEN" });
  }
}

// ─── invoices ────────────────────────────────────────────────────────────────────────

export class InvoiceNotFoundError extends NotFoundError {
  constructor() {
    super("Invoice not found", { code: "INVOICE_NOT_FOUND" });
  }
}

export class PaymentNotPaidError extends BadRequestError {
  constructor() {
    super("Only a paid payment gets an invoice", { code: "PAYMENT_NOT_PAID" });
  }
}

// ─── Zoho Books ──────────────────────────────────────────────────────────────────────

export class ZohoNotConfiguredError extends ServiceUnavailableError {
  constructor() {
    super("Zoho Books is not set up on the server (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_TOKEN_KEY)", {
      code: "ZOHO_NOT_CONFIGURED",
    });
  }
}

export class ZohoNotConnectedError extends ConflictError {
  constructor(message = "Connect Zoho Books first (Billing → Zoho Books)") {
    super(message, { code: "ZOHO_NOT_CONNECTED" });
  }
}

export class ZohoInvoiceNotFoundError extends NotFoundError {
  constructor() {
    super("This Zoho invoice is not known here. Run Sync now first.", { code: "ZOHO_INVOICE_NOT_FOUND" });
  }
}

export class ZohoInvoiceNotApplicableError extends ConflictError {
  constructor() {
    super("Only a paid invoice that hasn't been applied or set aside can be applied", {
      code: "ZOHO_INVOICE_NOT_APPLICABLE",
    });
  }
}
