import type { PaymentGateway } from "../../../integrations/razorpay/razorpay.client.js";
import type { Logger } from "../../../shared/logger/logger.js";
import { WebhookNotConfiguredError, WebhookSignatureInvalidError } from "../errors/billing.errors.js";
import type { AutoRenewService } from "./auto-renew.service.js";
import type { CheckoutService } from "./checkout.service.js";

interface PaymentEntity {
  id?: string;
  order_id?: string | null;
  amount?: number;
  method?: string | null;
  error_description?: string | null;
}

interface WebhookBody {
  event?: string;
  payload?: {
    payment?: { entity?: PaymentEntity };
    subscription?: { entity?: { id?: string; notes?: { ndid?: string } | unknown[] } };
  };
}

/**
 * Razorpay's webhook (Account & Settings → Webhooks → our URL). It confirms payments when the
 * browser never came back (closed tab, lost network) and drives auto-renew. Events for orders
 * that are not ours (gian's old checkout uses the same Razorpay account) are ignored.
 *
 * Subscribe to: payment.captured, payment.failed, order.paid, subscription.authenticated,
 * subscription.activated, subscription.charged, subscription.halted, subscription.paused,
 * subscription.resumed, subscription.cancelled, subscription.completed.
 */
export class BillingWebhookService {
  constructor(
    private readonly gateway: PaymentGateway | null,
    private readonly checkout: CheckoutService,
    private readonly autoRenew: AutoRenewService,
    private readonly logger: Logger,
  ) {}

  async handle(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    if (!this.gateway?.webhookEnabled) throw new WebhookNotConfiguredError();
    if (!rawBody || !signature || !this.gateway.verifyWebhook(rawBody, signature)) throw new WebhookSignatureInvalidError();

    const body = JSON.parse(rawBody.toString("utf8")) as WebhookBody;
    const event = body.event ?? "";
    const payment = body.payload?.payment?.entity;
    this.logger.info({ event, paymentId: payment?.id, orderId: payment?.order_id }, "razorpay webhook");

    if (event.startsWith("subscription.")) {
      const entity = body.payload?.subscription?.entity;
      if (!entity?.id) return;
      const notes = entity.notes && !Array.isArray(entity.notes) ? entity.notes : {};
      await this.autoRenew.onEvent({
        event,
        subscriptionId: entity.id,
        notesNdid: (notes as { ndid?: string }).ndid ?? null,
        payment:
          payment?.id && typeof payment.amount === "number"
            ? { id: payment.id, orderId: payment.order_id ?? null, amount: payment.amount, method: payment.method ?? null }
            : null,
      });
      return;
    }

    if (!payment?.id || !payment.order_id) return;
    if (event === "payment.captured" || event === "order.paid") {
      await this.checkout.applyPaid(payment.order_id, {
        paymentId: payment.id,
        method: payment.method ?? null,
        paidAt: new Date(),
      });
    } else if (event === "payment.failed") {
      await this.checkout.failed(payment.order_id, payment.error_description ?? "Payment failed", payment.id);
    }
  }
}
