import type { Mailer } from "../../../integrations/mail/mailer.js";
import type { Logger } from "../../../shared/logger/logger.js";
import type { IssuedInvoice } from "./invoice.service.js";

export type BillingRecipients = (ndid: string) => Promise<{ to: string[]; hotelName: string | null }>;

export interface ReceiptInput {
  ndid: string;
  planName: string;
  cycleMonths: number;
  amountPaise: number;
  paymentId: string | null;
  periodEnd: Date;
  autoRenew: boolean;
  /** attached as a PDF when it could be made */
  invoice?: IssuedInvoice | null;
}

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

/** Emails about billing. A failed email never fails a payment: it is logged and skipped. */
export class BillingNotifier {
  constructor(
    private readonly mailer: Mailer,
    private readonly recipients: BillingRecipients,
    private readonly logger: Logger,
  ) {}

  async paymentReceived(input: ReceiptInput): Promise<void> {
    try {
      const { to, hotelName } = await this.recipients(input.ndid);
      const cycle = input.cycleMonths === 1 ? "1 month" : `${input.cycleMonths} months`;
      const text = [
        `Hello${hotelName ? ` ${hotelName}` : ""},`,
        "",
        input.autoRenew
          ? `Your Eazotel ${input.planName} plan renewed automatically.`
          : `Thank you. We received your payment for the Eazotel ${input.planName} plan.`,
        "",
        `Amount paid: ${rupees(input.amountPaise)} (GST included)`,
        `Billing period: ${cycle}`,
        `Valid until: ${day(input.periodEnd)}`,
        ...(input.paymentId ? [`Payment ID: ${input.paymentId}`] : []),
        ...(input.invoice ? [`Invoice: ${input.invoice.invoice.number} (attached)`] : []),
        "",
        "You can see every payment and download every invoice in your dashboard under Settings → Subscription.",
        "",
        "Team Eazotel",
      ].join("\n");
      for (const address of to) {
        await this.mailer.send({
          to: address,
          subject: `Payment received: Eazotel ${input.planName} plan`,
          text,
          ...(input.invoice
            ? { attachments: [{ filename: input.invoice.filename, content: input.invoice.pdf, contentType: "application/pdf" }] }
            : {}),
        });
      }
    } catch (error) {
      this.logger.warn({ err: error, ndid: input.ndid }, "billing receipt email failed");
    }
  }
}
