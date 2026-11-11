import type { ZohoBooksApi, ZohoContact } from "../../../integrations/zoho/zoho-books.client.js";
import type { Logger } from "../../../shared/logger/logger.js";
import type { BillingDetailsStore, Quote } from "../types/billing.types.js";
import type { ZohoCustomerLink, ZohoInvoiceRecord, ZohoStore } from "../types/zoho.types.js";
import type { HotelLookup } from "./invoice.service.js";
import type { ZohoConnectionService } from "./zoho-connection.service.js";

const DUE_DAYS = 7;

const ymd = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

/**
 * Makes Zoho Books invoices from our own price quote, so a plan costs the same whichever way
 * a hotel pays. Each quote line becomes an invoice line for the whole period; the cycle
 * discount, offer and credit become one discount before tax; Zoho adds the GST chosen in the
 * admin console. The invoice is marked sent so its payment page works, and can be emailed by
 * Zoho to the hotel.
 *
 * A client without a Zoho customer gets one, made from its profile and billing details, and
 * linked to it.
 */
export class ZohoInvoicingService {
  constructor(
    private readonly connection: ZohoConnectionService,
    private readonly api: ZohoBooksApi | null,
    private readonly store: ZohoStore,
    private readonly hotel: HotelLookup,
    private readonly billingDetails: BillingDetailsStore,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The client's Zoho customer, made and linked if it has none. */
  async customerFor(ndid: string, by: string): Promise<ZohoCustomerLink> {
    const existing = await this.store.linkByNdid(ndid);
    if (existing) return existing;
    const { connection, access } = await this.connection.session();
    const [info, details] = await Promise.all([this.hotel(ndid), this.billingDetails.get(ndid)]);
    const contact: ZohoContact = await this.api!.createContact(access, connection.orgId, {
      name: details?.legalName || info.hotelName || ndid,
      email: details?.email || info.hotelEmail || info.ownerEmail,
      phone: info.hotelPhone,
      gstin: details?.gstin || null,
    });
    const link: ZohoCustomerLink = {
      ndid,
      contactId: contact.contactId,
      contactName: contact.name,
      linkedBy: by,
      linkedAt: this.now(),
    };
    await this.store.saveLink(link);
    this.logger.info({ ndid, contactId: contact.contactId }, "Zoho customer created for client");
    return link;
  }

  /** Creates, sends and (optionally) emails the invoice; records it against `orderId`. */
  async invoiceForQuote(input: {
    ndid: string;
    quote: Quote;
    orderId: string;
    by: string;
    emailTo: string[];
  }): Promise<ZohoInvoiceRecord> {
    const { ndid, quote, orderId, by, emailTo } = input;
    const customer = await this.customerFor(ndid, by);
    const { connection, access } = await this.connection.session();
    const api = this.api!;
    const months = quote.cycleMonths;
    const now = this.now();

    const created = await api.createInvoice(access, connection.orgId, {
      customerId: customer.contactId,
      referenceNumber: orderId,
      date: ymd(now),
      dueDate: ymd(new Date(now.getTime() + DUE_DAYS * 86_400_000)),
      lineItems: quote.lines.map((line) => ({
        name: line.label,
        description: `${quote.cycleLabel} (${months === 1 ? "1 month" : `${months} months`})`,
        rate: (line.monthlyPaise * months) / 100,
        quantity: 1,
        taxId: connection.taxId,
      })),
      discount: (quote.grossPaise - quote.taxablePaise) / 100,
      notes: `Eazotel ${quote.plan.name} plan, ${quote.cycleLabel}. Your plan renews as soon as this invoice is paid.`,
    });
    await api.markSent(access, connection.orgId, created.invoiceId);
    if (emailTo.length) {
      await api.emailInvoice(access, connection.orgId, created.invoiceId, emailTo).catch((err: unknown) => {
        this.logger.warn(
          { err, invoiceId: created.invoiceId },
          "Zoho could not email the invoice; the link still works",
        );
      });
    }
    const sent = (await api.invoice(access, connection.orgId, created.invoiceId)) ?? created;
    if (Math.abs(Math.round(sent.total * 100) - quote.totalPaise) > 100) {
      // Zoho's tax setup differs from ours: the hotel pays Zoho's total, staff should check the tax
      this.logger.warn(
        { invoiceId: sent.invoiceId, zoho: sent.total, ours: quote.totalPaise / 100 },
        "Zoho invoice total differs from the quote",
      );
    }
    return this.store.upsertInvoice(
      sent.invoiceId,
      {
        number: sent.number,
        contactId: customer.contactId,
        contactName: customer.contactName,
        ndid,
        source: "checkout",
        orderId,
        status: sent.status,
        totalPaise: Math.round(sent.total * 100),
        currency: sent.currencyCode,
        invoiceUrl: sent.invoiceUrl,
        invoiceDate: sent.date,
        lines: sent.lineItems.map((l) => l.name),
      },
      now,
    );
  }
}
