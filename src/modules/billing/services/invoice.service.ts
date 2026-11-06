import type { Mailer } from "../../../integrations/mail/mailer.js";
import type { Logger } from "../../../shared/logger/logger.js";
import { InvoiceNotFoundError, PaymentNotPaidError } from "../errors/billing.errors.js";
import type {
  BillingDetails,
  BillingDetailsStore,
  InvoiceParty,
  InvoiceRecord,
  InvoiceStore,
  PaymentRecord,
  PaymentStore,
} from "../types/billing.types.js";
import type { BillingCatalogueService } from "./billing-catalogue.service.js";
import { InvoiceBuilder } from "./invoice-builder.js";
import { InvoiceRenderer } from "./invoice-renderer.js";

/** What billing knows about a hotel from other modules (profiles, users). */
export interface HotelInfo {
  hotelName: string | null;
  hotelEmail: string | null;
  hotelPhone: string | null;
  ownerEmail: string | null;
  city: string | null;
  state: string | null;
  pinCode: string | null;
}
export type HotelLookup = (ndid: string) => Promise<HotelInfo>;

export interface IssuedInvoice {
  invoice: InvoiceRecord;
  pdf: Buffer;
  filename: string;
}

/**
 * GST invoices: one per successful payment, numbered per financial year, never changed once
 * issued (a hotel that fixes its GSTIN later gets it on the next invoice). The hotel downloads
 * them from its dashboard; staff download and email them from the admin console.
 */
export class InvoiceService {
  constructor(
    private readonly invoices: InvoiceStore,
    private readonly details: BillingDetailsStore,
    private readonly catalogue: BillingCatalogueService,
    private readonly payments: PaymentStore,
    private readonly hotel: HotelLookup,
    private readonly mailer: Mailer,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** What the hotel's invoices show: saved details, or what its profile says. */
  async billingDetails(ndid: string): Promise<BillingDetails> {
    const [saved, info] = await Promise.all([this.details.get(ndid), this.hotel(ndid)]);
    return {
      legalName: saved?.legalName || info.hotelName || "",
      gstin: saved?.gstin ?? "",
      address: saved?.address ?? "",
      city: saved?.city || info.city || "",
      state: saved?.state || info.state || "",
      pinCode: saved?.pinCode || info.pinCode || "",
      email: saved?.email || info.hotelEmail || info.ownerEmail || "",
    };
  }

  async saveBillingDetails(ndid: string, details: BillingDetails): Promise<BillingDetails> {
    await this.details.save(ndid, details, this.now());
    return this.billingDetails(ndid);
  }

  /** The invoice for a paid payment, made now if it doesn't exist yet. */
  async issue(payment: PaymentRecord): Promise<InvoiceRecord> {
    if (payment.status !== "SUCCESS") throw new PaymentNotPaidError();
    const existing = await this.invoices.byOrderId(payment.orderId);
    if (existing) return existing;
    const issuedAt = payment.paidAt ?? this.now();
    const [settings, buyer, plan] = await Promise.all([
      this.catalogue.settings(),
      this.buyer(payment.ndid),
      payment.planId ? this.catalogue.plan(payment.planId) : Promise.resolve(null),
    ]);
    const invoice = InvoiceBuilder.build({
      payment,
      settings,
      buyer,
      planName: plan?.name ?? payment.terms?.planCode ?? payment.quote?.plan.name ?? "Eazotel",
      issuedAt,
    });
    const yearKey = InvoiceBuilder.financialYear(issuedAt);
    return this.invoices.create(invoice, (seq) => InvoiceBuilder.number(settings.invoice.prefix, yearKey, seq), yearKey);
  }

  /** After a payment: the invoice and its PDF, or null (logged) so a problem never fails the payment. */
  async issueQuietly(orderId: string): Promise<IssuedInvoice | null> {
    try {
      const payment = await this.payments.findByOrderId(orderId);
      if (!payment || payment.status !== "SUCCESS" || payment.amount <= 0) return null;
      return this.withPdf(await this.issue(payment));
    } catch (error) {
      this.logger.error({ err: error, orderId }, "invoice could not be issued");
      return null;
    }
  }

  /** Staff: an invoice for a paid payment that has none (e.g. from gian's old checkout). */
  async issueForOrder(orderId: string): Promise<InvoiceRecord> {
    const payment = await this.payments.findByOrderId(orderId);
    if (!payment) throw new InvoiceNotFoundError();
    return this.issue(payment);
  }

  async get(id: string): Promise<InvoiceRecord> {
    const invoice = await this.invoices.byId(id);
    if (!invoice) throw new InvoiceNotFoundError();
    return invoice;
  }

  /** An invoice of this hotel; another hotel's answers "not found". */
  async forHotel(ndid: string, id: string): Promise<InvoiceRecord> {
    const invoice = await this.invoices.byId(id);
    if (!invoice || invoice.ndid !== ndid) throw new InvoiceNotFoundError();
    return invoice;
  }

  withPdf(invoice: InvoiceRecord): IssuedInvoice {
    return { invoice, pdf: InvoiceRenderer.render(invoice), filename: InvoiceService.filename(invoice) };
  }

  /** Emails the PDF to each address. Returns the addresses used. */
  async email(invoice: InvoiceRecord, to: string[]): Promise<string[]> {
    const recipients = [...new Set(to.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    const { pdf, filename } = this.withPdf(invoice);
    const total = `₹${(invoice.totalPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
    for (const address of recipients) {
      await this.mailer.send({
        to: address,
        subject: `Invoice ${invoice.number} from ${invoice.seller.name}`,
        text: [
          `Hello ${invoice.buyer.name},`,
          "",
          `Please find attached invoice ${invoice.number} for ${total}, paid on ${invoice.issuedAt.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}.`,
          "",
          "You can also download every invoice from your dashboard under Settings → Subscription.",
          "",
          `Team ${invoice.seller.name}`,
        ].join("\n"),
        attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
      });
    }
    await this.invoices.markEmailed(invoice.id, recipients, this.now());
    return recipients;
  }

  /** Where an invoice goes by default: the invoice email, the hotel email, the owner. */
  async defaultRecipients(ndid: string): Promise<string[]> {
    const [details, info] = await Promise.all([this.details.get(ndid), this.hotel(ndid)]);
    return [...new Set([details?.email, info.hotelEmail, info.ownerEmail].filter((e): e is string => Boolean(e)))];
  }

  numbersFor(orderIds: string[]): Promise<Map<string, { id: string; number: string }>> {
    return this.invoices.numbersFor(orderIds);
  }

  static filename(invoice: InvoiceRecord): string {
    return `Eazotel-invoice-${invoice.number.replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;
  }

  private async buyer(ndid: string): Promise<InvoiceParty> {
    const [d, info] = await Promise.all([this.billingDetails(ndid), this.hotel(ndid)]);
    const cityLine = [d.city, d.pinCode].filter(Boolean).join(" - ");
    return {
      name: d.legalName || info.hotelName || "Hotel",
      addressLines: [...d.address.split("\n").map((l) => l.trim()).filter(Boolean), ...(cityLine ? [cityLine] : [])],
      state: d.state || null,
      gstin: d.gstin || null,
      email: d.email || null,
      phone: info.hotelPhone,
    };
  }
}
