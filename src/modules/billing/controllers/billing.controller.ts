import type { ZohoConnectionService } from "../services/zoho-connection.service.js";
import type { ZohoSyncService } from "../services/zoho-sync.service.js";
import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import type {
  AutoRenewBody,
  BillingDetailsBody,
  InvoiceParams,
  CheckoutBody,
  ConfirmAutoRenewBody,
  ConfirmPaymentBody,
  PurchaseChoiceBody,
} from "../dtos/billing.dto.js";
import type { AutoRenewService } from "../services/auto-renew.service.js";
import type { BillingCatalogueService } from "../services/billing-catalogue.service.js";
import type { BillingWebhookService } from "../services/billing-webhook.service.js";
import { CheckoutService, type BillingActor } from "../services/checkout.service.js";
import type { InvoiceService } from "../services/invoice.service.js";

/** /api/v1/billing: the hotel dashboard's plans page, the website's pricing page and Razorpay's webhook. */
export class BillingController extends BaseController {
  constructor(
    private readonly catalogue: BillingCatalogueService,
    private readonly checkout: CheckoutService,
    private readonly autoRenew: AutoRenewService,
    private readonly webhook: BillingWebhookService,
    private readonly invoices: InvoiceService,
    private readonly zohoConnection: ZohoConnectionService,
    private readonly zohoSync: ZohoSyncService,
  ) {
    super();
  }

  async publicCatalogue(_req: Request, res: Response): Promise<void> {
    res.setHeader("Cache-Control", "public, max-age=60");
    this.ok(res, await this.catalogue.publicCatalogue());
  }

  async account(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.checkout.account(BillingController.actor(req)));
  }

  async quote(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.checkout.quote(BillingController.actor(req), req.body as PurchaseChoiceBody));
  }

  async start(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.checkout.start(BillingController.actor(req), req.body as CheckoutBody));
  }

  async confirm(req: Request, res: Response): Promise<void> {
    const body = req.body as ConfirmPaymentBody;
    this.ok(
      res,
      await this.checkout.confirm(BillingController.actor(req), {
        orderId: body.razorpay_order_id,
        paymentId: body.razorpay_payment_id,
        signature: body.razorpay_signature,
      }),
    );
  }

  async setAutoRenew(req: Request, res: Response): Promise<void> {
    const actor = BillingController.actor(req);
    if ((req.body as AutoRenewBody).enabled) {
      this.ok(res, { status: "authorize", ...(await this.autoRenew.enable(actor)) });
      return;
    }
    await this.autoRenew.disable(actor);
    this.ok(res, { status: "off", account: await this.checkout.account(actor) });
  }

  async confirmAutoRenew(req: Request, res: Response): Promise<void> {
    const actor = BillingController.actor(req);
    const body = req.body as ConfirmAutoRenewBody;
    await this.autoRenew.confirm(actor, {
      subscriptionId: body.razorpay_subscription_id,
      paymentId: body.razorpay_payment_id,
      signature: body.razorpay_signature,
    });
    this.ok(res, await this.checkout.account(actor));
  }

  async invoicePdf(req: Request, res: Response): Promise<void> {
    const { id } = req.validated?.params as InvoiceParams;
    const invoice = await this.invoices.forHotel(BillingController.actor(req).ndid, id);
    const { pdf, filename } = this.invoices.withPdf(invoice);
    BillingController.sendPdf(res, pdf, filename);
  }

  async billingDetails(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.invoices.billingDetails(BillingController.actor(req).ndid));
  }

  async saveBillingDetails(req: Request, res: Response): Promise<void> {
    const actor = BillingController.actor(req);
    CheckoutService.mustPay(actor);
    this.ok(res, await this.invoices.saveBillingDetails(actor.ndid, req.body as BillingDetailsBody));
  }

  static sendPdf(res: Response, pdf: Buffer, filename: string): void {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).end(pdf);
  }

  /** Zoho's sign-in comes back here (no token: the one-time state proves who started it). */
  async zohoCallback(req: Request, res: Response): Promise<void> {
    const q = req.query as Record<string, string | undefined>;
    res.redirect(302, await this.zohoConnection.finishConnect(q.code, q.state, q.error));
  }

  /** Zoho Books' workflow webhook (invoice paid). Answers 200 once the token is right, so Zoho doesn't retry. */
  async zohoWebhook(req: Request, res: Response): Promise<void> {
    const token =
      (req.query as Record<string, string | undefined>).token ?? req.get("x-zoho-webhook-token") ?? undefined;
    await this.zohoSync.handleWebhook(token, req.body);
    res.status(200).json({ ok: true });
  }

  /** Razorpay retries anything that isn't 2xx, so a handled event always answers 200. */
  async razorpayWebhook(req: Request, res: Response): Promise<void> {
    await this.webhook.handle(req.rawBody, req.get("x-razorpay-signature") ?? undefined);
    res.status(200).json({ ok: true });
  }

  private static actor(req: Request): BillingActor {
    const auth = req.auth!;
    return {
      ndid: auth.ndid,
      email: auth.email,
      isAdmin: auth.isAdmin,
      staffEmail: auth.actor?.email ?? null,
    };
  }
}
