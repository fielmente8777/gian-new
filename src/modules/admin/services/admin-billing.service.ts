import type {
  AdminCatalogue,
  AppInput,
  BillingOverview,
  BillingPort,
  BillingSettings,
  CatalogueApp,
  CataloguePlan,
  Changed,
  InvoiceRecord,
  NewOffer,
  Offer,
  PaymentListItem,
  PaymentPage,
  PaymentQuery,
  PlanInput,
  SettingsInput,
} from "../../billing/index.js";
import type { AdminAuditAction, AdminRecord, AuditChanges } from "../types/admin.types.js";
import type { AdminAuditService } from "./admin-audit.service.js";
import { ClientNotFoundError } from "../errors/admin.errors.js";
import { AdminPermissions } from "./admin-permissions.service.js";

/** A payment row with its invoice, once issued. */
export type PaymentRow = PaymentListItem & { invoice: { id: string; number: string } | null };

/** An invoice as the email dialog needs it. */
export interface InvoiceSummary {
  id: string;
  number: string;
  ndid: string;
  buyerName: string;
  totalPaise: number;
  issuedAt: Date;
  emailedTo: string[];
  lastEmailedAt: Date | null;
  /** the invoice email, the hotel email and the owner */
  suggestedRecipients: string[];
}

/**
 * Staff manage what Eazotel sells (plans, add-on apps, billing cycles, GST, seat price,
 * offers) and see who paid. Every catalogue change is logged with old and new values.
 */
export class AdminBillingService {
  constructor(
    private readonly billing: BillingPort,
    private readonly audit: AdminAuditService,
  ) {}

  overview(): Promise<BillingOverview> {
    return this.billing.reports.overview();
  }

  /** An admin with assigned properties sees only those clients' payments. */
  async payments(admin: AdminRecord, query: Omit<PaymentQuery, "ndids">): Promise<{ items: PaymentRow[]; total: number }> {
    const scope = AdminPermissions.propertyScope(admin);
    if (scope && query.ndid && !scope.has(query.ndid)) return { items: [], total: 0 };
    if (scope?.size === 0) return { items: [], total: 0 };
    const page: PaymentPage = await this.billing.reports.payments({ ...query, ...(scope ? { ndids: [...scope.keys()] } : {}) });
    const invoices = await this.billing.invoices.numbersFor(page.items.map((p) => p.orderId));
    return { ...page, items: page.items.map((p) => ({ ...p, invoice: invoices.get(p.orderId) ?? null })) };
  }

  async invoice(admin: AdminRecord, id: string): Promise<InvoiceSummary> {
    const invoice = await this.visibleInvoice(admin, id);
    return {
      id: invoice.id,
      number: invoice.number,
      ndid: invoice.ndid,
      buyerName: invoice.buyer.name,
      totalPaise: invoice.totalPaise,
      issuedAt: invoice.issuedAt,
      emailedTo: invoice.emailedTo,
      lastEmailedAt: invoice.lastEmailedAt,
      suggestedRecipients: await this.billing.invoices.defaultRecipients(invoice.ndid),
    };
  }

  async invoicePdf(admin: AdminRecord, id: string): Promise<{ pdf: Buffer; filename: string }> {
    return this.billing.invoices.withPdf(await this.visibleInvoice(admin, id));
  }

  /** Emails the invoice; with no addresses, to the hotel's usual ones. */
  async emailInvoice(admin: AdminRecord, id: string, to: string[], ip?: string): Promise<InvoiceSummary> {
    const invoice = await this.visibleInvoice(admin, id);
    const recipients = to.length ? to : await this.billing.invoices.defaultRecipients(invoice.ndid);
    const sent = await this.billing.invoices.email(invoice, recipients);
    await this.audit.record({
      action: "billing.invoice_emailed",
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: invoice.ndid,
      targetEmail: sent.join(", "),
      changes: null,
      details: { invoice: invoice.number },
      ip,
    });
    return this.invoice(admin, id);
  }

  /** An invoice for a paid payment that has none (older checkout). */
  async createInvoice(admin: AdminRecord, orderId: string, ip?: string): Promise<InvoiceSummary> {
    const invoice = await this.billing.invoices.issueForOrder(orderId);
    const scope = AdminPermissions.propertyScope(admin);
    if (scope && !scope.has(invoice.ndid)) throw new ClientNotFoundError();
    await this.audit.record({
      action: "billing.invoice_created",
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: invoice.ndid,
      targetEmail: null,
      changes: null,
      details: { invoice: invoice.number, orderId },
      ip,
    });
    return this.invoice(admin, invoice.id);
  }

  private async visibleInvoice(admin: AdminRecord, id: string): Promise<InvoiceRecord> {
    const invoice = await this.billing.invoices.get(id);
    const scope = AdminPermissions.propertyScope(admin);
    if (scope && !scope.has(invoice.ndid)) throw new ClientNotFoundError();
    return invoice;
  }

  catalogue(): Promise<AdminCatalogue> {
    return this.billing.catalogue.adminCatalogue();
  }

  async createPlan(admin: AdminRecord, input: PlanInput, ip?: string): Promise<CataloguePlan> {
    return this.log(admin, "billing.plan_created", await this.billing.catalogue.createPlan(input, admin.email), ip, (p) => p.code);
  }

  async updatePlan(admin: AdminRecord, id: string, changes: Partial<PlanInput>, ip?: string): Promise<CataloguePlan> {
    return this.log(admin, "billing.plan_updated", await this.billing.catalogue.updatePlan(id, changes, admin.email), ip, (p) => p.code);
  }

  async createApp(admin: AdminRecord, input: AppInput, ip?: string): Promise<CatalogueApp> {
    return this.log(admin, "billing.app_created", await this.billing.catalogue.createApp(input), ip, (a) => a.code);
  }

  async updateApp(admin: AdminRecord, id: string, changes: Partial<AppInput>, ip?: string): Promise<CatalogueApp> {
    return this.log(admin, "billing.app_updated", await this.billing.catalogue.updateApp(id, changes), ip, (a) => a.code);
  }

  async saveSettings(admin: AdminRecord, settings: SettingsInput, ip?: string): Promise<BillingSettings> {
    return this.log(admin, "billing.settings_updated", await this.billing.catalogue.saveSettings(settings, admin.email), ip, () => "settings");
  }

  async createOffer(admin: AdminRecord, input: NewOffer, ip?: string): Promise<Offer> {
    return this.log(admin, "billing.offer_created", await this.billing.catalogue.createOffer(input), ip, (o) => o.code);
  }

  async updateOffer(admin: AdminRecord, id: string, changes: Partial<NewOffer>, ip?: string): Promise<Offer> {
    return this.log(admin, "billing.offer_updated", await this.billing.catalogue.updateOffer(id, changes), ip, (o) => o.code);
  }

  private async log<T extends object>(
    admin: AdminRecord,
    action: AdminAuditAction,
    { before, after }: Changed<T>,
    ip: string | undefined,
    name: (item: T) => string,
  ): Promise<T> {
    const changes = AdminBillingService.diff(before, after);
    if (before && Object.keys(changes).length === 0) return after;
    await this.audit.record({
      action,
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: name(after),
      targetEmail: null,
      changes,
      details: null,
      ip,
    });
    return after;
  }

  /** Field by field; arrays and objects compared as JSON. Timestamps are left out. */
  static diff<T extends object>(before: T | null, after: T): AuditChanges {
    const skip = new Set(["id", "updatedAt", "updatedBy", "createdAt", "redemptions"]);
    const changes: AuditChanges = {};
    const a = after as Record<string, unknown>;
    const b = (before ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(a)) {
      if (skip.has(key)) continue;
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changes[key] = { from: b[key] ?? null, to: a[key] ?? null };
    }
    return changes;
  }
}
