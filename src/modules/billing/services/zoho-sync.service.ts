import { timingSafeEqual } from "node:crypto";

import type { ZohoBooksApi, ZohoInvoice } from "../../../integrations/zoho/zoho-books.client.js";
import type { Logger } from "../../../shared/logger/logger.js";
import type { SubscriptionBillingPort } from "../../subscriptions/index.js";
import {
  PlanNotAvailableError,
  WebhookSignatureInvalidError,
  ZohoInvoiceNotApplicableError,
  ZohoInvoiceNotFoundError,
} from "../errors/billing.errors.js";
import type { PaymentStore } from "../types/billing.types.js";
import type { ZohoInvoiceRecord, ZohoStore } from "../types/zoho.types.js";
import type { BillingCatalogueService } from "./billing-catalogue.service.js";
import type { PeriodActivator } from "./period-activator.js";
import type { ZohoConnectionService } from "./zoho-connection.service.js";

/** Pages of "paid, most recently changed first" read per check: 3 × 200 invoices. */
const POLL_PAGES = 3;

/** What staff confirm a Zoho-made invoice pays for. */
export interface ZohoApplyChoice {
  ndid: string;
  planId: string;
  cycleMonths: number;
  addonCodes: string[];
  seats: number;
}

export interface ZohoSyncSummary {
  checked: number;
  applied: number;
  needsReview: number;
}

/**
 * Keeps Zoho Books invoices and our subscriptions in step.
 *
 * - Zoho's workflow webhook ("invoice paid") names an invoice; we never trust the body and
 *   read the invoice back from Zoho's API. A check every 30 minutes does the same for any
 *   paid invoice the webhook missed.
 * - An invoice we made (dashboard or console) has a payment waiting: it is applied by the
 *   same code as a Razorpay payment, once.
 * - An invoice the team made in Zoho waits for staff to say which client and plan it pays
 *   for (prefilled from the customer link); then it is applied the same way. A renewal of the
 *   same plan starts where the current period ends, so no day is lost.
 */
export class ZohoSyncService {
  constructor(
    private readonly store: ZohoStore,
    private readonly connection: ZohoConnectionService,
    private readonly api: ZohoBooksApi | null,
    private readonly payments: PaymentStore,
    private readonly applyPaid: (
      orderId: string,
      paid: { paymentId: string; method: string | null; paidAt: Date },
    ) => Promise<boolean>,
    private readonly activator: PeriodActivator,
    private readonly catalogue: BillingCatalogueService,
    private readonly subscriptions: Pick<SubscriptionBillingPort, "snapshot">,
    private readonly webhookToken: string | null,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Zoho's webhook. The token in the URL is the only thing trusted; the invoice is re-read from Zoho. */
  async handleWebhook(token: string | undefined, body: unknown): Promise<void> {
    if (!this.webhookToken || !token || !ZohoSyncService.same(token, this.webhookToken))
      throw new WebhookSignatureInvalidError();
    const invoiceId = ZohoSyncService.invoiceIdIn(body);
    if (!invoiceId) {
      this.logger.warn("Zoho webhook without an invoice id: ignored");
      return;
    }
    await this.syncInvoice(invoiceId);
  }

  /** Reads one invoice from Zoho and applies it if it is paid and ours. */
  async syncInvoice(invoiceId: string): Promise<ZohoInvoiceRecord | null> {
    const { connection, access } = await this.connection.session();
    const invoice = await this.api!.invoice(access, connection.orgId, invoiceId);
    if (!invoice) return null;
    return this.settle(invoice);
  }

  /** The 30-minute check, and the console's "Sync now". */
  async syncRecent(): Promise<ZohoSyncSummary> {
    const summary: ZohoSyncSummary = { checked: 0, applied: 0, needsReview: 0 };
    try {
      const { connection, access } = await this.connection.session();
      for (let page = 1; page <= POLL_PAGES; page += 1) {
        const { items, hasMore } = await this.api!.recentlyPaid(access, connection.orgId, page);
        let allKnown = true;
        for (const invoice of items) {
          summary.checked += 1;
          const known = await this.store.invoice(invoice.invoiceId);
          if (known?.appliedAt || known?.ignoredAt) continue;
          allKnown = false;
          const record = await this.settle(invoice);
          if (record.appliedAt) summary.applied += 1;
          else summary.needsReview += 1;
        }
        // newest changes come first: a page with nothing new means the rest is old news
        if (!hasMore || allKnown) break;
      }
      await this.connection.recordSync(null);
    } catch (err) {
      await this.connection.recordSync(err instanceof Error ? err.message : String(err)).catch(() => undefined);
      throw err;
    }
    if (summary.applied || summary.needsReview) this.logger.info(summary, "Zoho Books sync");
    return summary;
  }

  /** Staff confirm which client and plan a Zoho-made invoice pays for. Applied once. */
  async apply(invoiceId: string, choice: ZohoApplyChoice, by: string): Promise<ZohoInvoiceRecord> {
    const record = await this.store.invoice(invoiceId);
    if (!record) throw new ZohoInvoiceNotFoundError();
    if (record.appliedAt) return record;
    if (record.status !== "paid" || record.ignoredAt) throw new ZohoInvoiceNotApplicableError();
    if (record.source === "checkout" && record.orderId) {
      // ours: the payment already says what it is for
      const refreshed = await this.syncInvoice(invoiceId);
      return refreshed ?? record;
    }

    const [plan, settings, snapshot] = await Promise.all([
      this.catalogue.plan(choice.planId),
      this.catalogue.settings(),
      this.subscriptions.snapshot(choice.ndid),
    ]);
    if (!plan) throw new PlanNotAvailableError();
    const now = this.now();
    const running = snapshot && !snapshot.staffStop && snapshot.endDate > now;
    const kind = running && snapshot.planId === plan.id ? "renew" : "new";
    const terms = {
      planId: plan.id,
      planCode: plan.code,
      cycleMonths: choice.cycleMonths,
      addonCodes: choice.addonCodes,
      seats: choice.seats,
    };
    const orderId = `zoho_${invoiceId}`;
    const paymentId = `zoho:${record.number || invoiceId}`;

    const inserted = await this.payments.insertApplied(
      {
        ndid: choice.ndid,
        orderId,
        paymentId,
        planId: plan.id,
        amount: record.totalPaise,
        currency: record.currency,
        status: "SUCCESS",
        method: "zoho",
        paidAt: now,
        createdAt: now,
        source: "gian-new",
        kind,
        terms,
        quote: null,
        offerCode: null,
        periodStart: null,
        periodEnd: null,
        autoRenewRequested: false,
        createdBy: by,
      },
      now,
    );
    if (inserted) {
      await this.activator.apply(
        {
          ndid: choice.ndid,
          terms,
          kind,
          // the period's value before GST, for a later plan change's credit
          netPaise: Math.round((record.totalPaise * 100) / (100 + settings.gstPercent)),
          paymentRef: orderId,
          orderId,
          paymentId,
        },
        now,
      );
      this.logger.info({ ndid: choice.ndid, invoiceId, kind, by }, "Zoho invoice applied by staff");
    }
    // the customer now belongs to this client, so its next invoice is prefilled
    if (
      !(await this.store.linkByContact(record.contactId)) &&
      record.contactId &&
      !(await this.store.linkByNdid(choice.ndid))
    ) {
      await this.store.saveLink({
        ndid: choice.ndid,
        contactId: record.contactId,
        contactName: record.contactName,
        linkedBy: by,
        linkedAt: now,
      });
    }
    return this.store.upsertInvoice(invoiceId, { ndid: choice.ndid, orderId, appliedAt: now }, now);
  }

  /** Invoices we know of, newest change first. */
  list(state: "review" | "applied" | "open" | "all", limit: number): Promise<ZohoInvoiceRecord[]> {
    return this.store.invoices({ state, limit });
  }

  /** The plan the client is on now, to prefill a Zoho-made invoice. */
  async currentPlanId(ndid: string): Promise<string | null> {
    return (await this.subscriptions.snapshot(ndid))?.planId ?? null;
  }

  /** Not a subscription payment (e.g. a website build): leaves the review list. */
  async ignore(invoiceId: string, by: string): Promise<ZohoInvoiceRecord> {
    const record = await this.store.invoice(invoiceId);
    if (!record) throw new ZohoInvoiceNotFoundError();
    if (record.appliedAt) throw new ZohoInvoiceNotApplicableError();
    return this.store.upsertInvoice(invoiceId, { ignoredAt: this.now(), ignoredBy: by }, this.now());
  }

  /** Saves what Zoho says, then applies it when it is paid and its payment is waiting. */
  private async settle(invoice: ZohoInvoice): Promise<ZohoInvoiceRecord> {
    const now = this.now();
    const known = await this.store.invoice(invoice.invoiceId);
    // our own invoices carry the order in the reference, even if the record was lost
    const orderId = known?.orderId ?? (invoice.referenceNumber.startsWith("zinv_") ? invoice.referenceNumber : null);
    const link = known?.ndid ? null : await this.store.linkByContact(invoice.customerId);
    let record = await this.store.upsertInvoice(
      invoice.invoiceId,
      {
        number: invoice.number,
        contactId: invoice.customerId,
        contactName: invoice.customerName,
        status: invoice.status,
        totalPaise: Math.round(invoice.total * 100),
        currency: invoice.currencyCode,
        invoiceUrl: invoice.invoiceUrl,
        invoiceDate: invoice.date,
        lines: invoice.lineItems.map((l) => l.name || l.description).filter(Boolean),
        ...(orderId ? { orderId, source: "checkout" as const } : {}),
        ...(link ? { ndid: link.ndid } : {}),
      },
      now,
    );

    if (
      invoice.status !== "paid" ||
      record.appliedAt ||
      record.ignoredAt ||
      !record.orderId ||
      record.source !== "checkout"
    )
      return record;
    const payment = await this.payments.findByOrderId(record.orderId);
    if (!payment) return record;
    const applied = await this.applyPaid(record.orderId, {
      paymentId: `zoho:${invoice.number || invoice.invoiceId}`,
      method: "zoho",
      paidAt: invoice.lastPaymentDate ? new Date(`${invoice.lastPaymentDate}T12:00:00+05:30`) : now,
    });
    if (applied || (await this.payments.findByOrderId(record.orderId))?.appliedAt) {
      record = await this.store.upsertInvoice(invoice.invoiceId, { appliedAt: now }, now);
    }
    return record;
  }

  /** Zoho lets the webhook body be shaped by hand; accept the usual shapes. */
  static invoiceIdIn(body: unknown): string | null {
    const read = (value: unknown): string | null => {
      if (!value || typeof value !== "object") return null;
      const o = value as Record<string, unknown>;
      const direct = o.invoice_id ?? (o.invoice as Record<string, unknown> | undefined)?.invoice_id;
      if (typeof direct === "string" || typeof direct === "number") return String(direct);
      if (typeof o.JSONString === "string") {
        try {
          return read(JSON.parse(o.JSONString));
        } catch {
          return null;
        }
      }
      return null;
    };
    return read(body);
  }

  private static same(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
}
