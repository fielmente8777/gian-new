import type { BillingPort } from "../../billing/index.js";
import type { ProfileRecord, ProfilesPort } from "../../profiles/index.js";
import { ClientNotFoundError } from "../errors/admin.errors.js";
import type { AdminAuditAction, AdminRecord } from "../types/admin.types.js";
import type { AdminAuditService } from "./admin-audit.service.js";
import { AdminPermissions } from "./admin-permissions.service.js";

type ZohoPort = BillingPort["zoho"];
type ZohoContact = Awaited<ReturnType<ZohoPort["customers"]["all"]>>[number];
type ZohoInvoiceRow = Awaited<ReturnType<ZohoPort["sync"]["apply"]>>;
export type PaymentProvider = "razorpay" | "zoho";

/** Words that say nothing about which hotel it is. */
const FILLER = new Set([
  "hotel",
  "hotels",
  "resort",
  "resorts",
  "the",
  "and",
  "pvt",
  "private",
  "ltd",
  "limited",
  "llp",
  "inn",
  "stay",
  "stays",
  "homestay",
  "villa",
  "villas",
  "retreat",
  "by",
  "a",
  "of",
]);
const CLIENT_PAGE = 100;
const MAX_CLIENTS = 3000;

export interface CustomerRow {
  contact: ZohoContact;
  linked: { ndid: string; hotelName: string | null } | null;
  /** the client this Zoho customer most likely is, when not linked */
  suggestion: { ndid: string; hotelName: string | null; why: string } | null;
}

export interface InvoiceRow extends ZohoInvoiceRow {
  hotelName: string | null;
  /** for a Zoho-made invoice waiting for staff: the client's current plan and a month count that fits the total */
  suggestion: { planId: string; planName: string; cycleMonths: number } | null;
}

export interface StaffInvoiceChoice {
  planId: string;
  cycleMonths: number;
  addonCodes: string[];
  seats: number;
  offerCode: string | null;
  emailTo: string[];
}

/**
 * Billing → Zoho Books in the admin console: connect Zoho Books, choose the GST tax, switch
 * where hotels pay, tie Zoho customers to clients (with name and email suggestions), confirm
 * invoices the team made in Zoho, and invoice a client through Zoho. Every change is logged.
 */
export class AdminZohoService {
  constructor(
    private readonly billing: BillingPort,
    private readonly profiles: ProfilesPort,
    private readonly audit: AdminAuditService,
  ) {}

  private get zoho(): ZohoPort {
    return this.billing.zoho;
  }

  status() {
    return this.zoho.connection.status();
  }

  async connect(admin: AdminRecord, ip?: string): Promise<{ url: string }> {
    const url = await this.zoho.connection.startConnect(admin.email);
    await this.log(admin, "zoho.connect_started", null, null, ip);
    return { url };
  }

  async disconnect(admin: AdminRecord, ip?: string) {
    const setup = await this.zoho.connection.disconnect();
    await this.log(admin, "zoho.disconnected", null, { paymentsNowGoThrough: setup.provider }, ip);
    return this.status();
  }

  taxes() {
    return this.zoho.connection.taxes();
  }

  async setTax(admin: AdminRecord, taxId: string | null, ip?: string) {
    const before = (await this.status()).taxName;
    await this.zoho.connection.setTax(taxId);
    const after = await this.status();
    await this.log(admin, "zoho.tax_changed", null, { from: before, to: after.taxName }, ip);
    return after;
  }

  async setProvider(admin: AdminRecord, provider: PaymentProvider, ip?: string) {
    const before = (await this.status()).payment.provider;
    if (before !== provider) {
      await this.zoho.connection.setProvider(provider, admin.email);
      await this.log(admin, "billing.payment_provider_changed", null, { from: before, to: provider }, ip);
    }
    return this.status();
  }

  /** Every Zoho customer, whose client it is, and a guess for the unlinked ones. */
  async customers(admin: AdminRecord): Promise<{ items: CustomerRow[]; unlinkedClients: number }> {
    const [contacts, links, clients] = await Promise.all([
      this.zoho.customers.all(true),
      this.zoho.customers.links(),
      this.clients(admin),
    ]);
    const byNdid = new Map(clients.map((c) => [c.ndid, c]));
    const linkedNdids = new Set(links.map((l) => l.ndid));
    const free = clients.filter((c) => !linkedNdids.has(c.ndid));
    const items = contacts.map((contact): CustomerRow => {
      const link = links.find((l) => l.contactId === contact.contactId);
      if (link)
        return {
          contact,
          linked: { ndid: link.ndid, hotelName: byNdid.get(link.ndid)?.hotelName ?? null },
          suggestion: null,
        };
      return { contact, linked: null, suggestion: AdminZohoService.bestMatch(contact, free) };
    });
    return { items, unlinkedClients: free.length };
  }

  async link(admin: AdminRecord, ndid: string, contactId: string, ip?: string) {
    const profile = await this.visibleClient(admin, ndid);
    const link = await this.zoho.customers.link(profile.ndid, contactId, admin.email);
    await this.log(
      admin,
      "zoho.customer_linked",
      profile.ndid,
      { hotelName: profile.hotelName, zohoCustomer: link.contactName },
      ip,
    );
    return link;
  }

  async unlink(admin: AdminRecord, ndid: string, ip?: string) {
    const profile = await this.visibleClient(admin, ndid);
    const before = await this.zoho.customers.linkOf(profile.ndid);
    await this.zoho.customers.unlink(profile.ndid);
    if (before)
      await this.log(
        admin,
        "zoho.customer_unlinked",
        profile.ndid,
        { hotelName: profile.hotelName, zohoCustomer: before.contactName },
        ip,
      );
  }

  async createCustomer(admin: AdminRecord, ndid: string, ip?: string) {
    const profile = await this.visibleClient(admin, ndid);
    const link = await this.zoho.customers.create(profile.ndid, admin.email);
    await this.log(
      admin,
      "zoho.customer_linked",
      profile.ndid,
      { hotelName: profile.hotelName, zohoCustomer: link.contactName, created: true },
      ip,
    );
    return link;
  }

  /** Zoho invoices we know of, with the hotel's name and, when waiting, a suggestion. */
  async invoices(
    admin: AdminRecord,
    state: "review" | "applied" | "open" | "all",
    limit: number,
  ): Promise<InvoiceRow[]> {
    const scope = AdminPermissions.propertyScope(admin);
    const rows = (await this.billing.zoho.sync.list(state, limit)).filter(
      (r) => !scope || (r.ndid !== null && scope.has(r.ndid)),
    );
    const plans = await this.billing.catalogue.plans();
    const settings = await this.billing.catalogue.settings();
    const out: InvoiceRow[] = [];
    for (const row of rows) {
      const profile = row.ndid ? await this.profiles.findByNdid(row.ndid) : null;
      let suggestion: InvoiceRow["suggestion"] = null;
      if (row.ndid && row.source === "zoho" && !row.appliedAt) {
        const current = await this.zoho.sync.currentPlanId(row.ndid);
        const plan = plans.find((p) => p.id === current) ?? null;
        if (plan && plan.price > 0) {
          // GST-inclusive total ÷ the plan's monthly price with GST, rounded to a cycle we sell
          const months = row.totalPaise / 100 / (plan.price * (1 + settings.gstPercent / 100));
          const cycles = settings.cycles.filter((c) => c.isActive).map((c) => c.months);
          const nearest = cycles.length
            ? cycles.reduce((a, b) => (Math.abs(b - months) < Math.abs(a - months) ? b : a))
            : Math.max(1, Math.round(months));
          suggestion = { planId: plan.id, planName: plan.name, cycleMonths: nearest };
        }
      }
      out.push({ ...row, hotelName: profile?.hotelName ?? null, suggestion });
    }
    return out;
  }

  async apply(
    admin: AdminRecord,
    invoiceId: string,
    choice: { ndid: string; planId: string; cycleMonths: number; addonCodes: string[]; seats: number },
    ip?: string,
  ) {
    const profile = await this.visibleClient(admin, choice.ndid);
    const row = await this.zoho.sync.apply(invoiceId, { ...choice, ndid: profile.ndid }, admin.email);
    await this.log(
      admin,
      "zoho.invoice_applied",
      profile.ndid,
      { invoice: row.number, months: choice.cycleMonths, planId: choice.planId, totalPaise: row.totalPaise },
      ip,
    );
    return row;
  }

  async ignore(admin: AdminRecord, invoiceId: string, ip?: string) {
    const row = await this.zoho.sync.ignore(invoiceId, admin.email);
    await this.log(admin, "zoho.invoice_ignored", row.ndid, { invoice: row.number }, ip);
    return row;
  }

  syncNow() {
    return this.zoho.sync.syncRecent();
  }

  /** A Zoho invoice for one client at the dashboard's prices; Zoho emails it when addresses are given. */
  async createInvoice(admin: AdminRecord, ndid: string, choice: StaffInvoiceChoice, ip?: string) {
    const profile = await this.visibleClient(admin, ndid);
    const made = await this.billing.checkout.zohoInvoiceForStaff(
      { ndid: profile.ndid, email: admin.email, isAdmin: false, staffEmail: admin.email },
      {
        planId: choice.planId,
        cycleMonths: choice.cycleMonths,
        addonCodes: choice.addonCodes,
        seats: choice.seats,
        offerCode: choice.offerCode,
      },
      choice.emailTo,
    );
    await this.log(
      admin,
      "zoho.invoice_created",
      profile.ndid,
      { invoice: made.invoiceNumber, totalPaise: made.totalPaise, emailedTo: choice.emailTo },
      ip,
    );
    return made;
  }

  /** The guess: same email, or the same hotel name once "Hotel", "Resort", "Pvt Ltd"… are left out. */
  static bestMatch(contact: ZohoContact, clients: ProfileRecord[]): CustomerRow["suggestion"] {
    const email = contact.email?.trim().toLowerCase();
    if (email) {
      const byEmail = clients.find((c) => c.hotelEmail?.trim().toLowerCase() === email);
      if (byEmail) return { ndid: byEmail.ndid, hotelName: byEmail.hotelName, why: "same email" };
    }
    const target = AdminZohoService.words(contact.companyName || contact.name);
    if (!target.length) return null;
    let best: { client: ProfileRecord; score: number } | null = null;
    for (const client of clients) {
      const words = AdminZohoService.words(client.hotelName ?? "");
      if (!words.length) continue;
      const a = target.join("");
      const b = words.join("");
      const shared = words.filter((w) => target.includes(w)).length;
      const score =
        a === b
          ? 1
          : (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b))
            ? 0.85
            : shared / Math.max(words.length, target.length);
      if (!best || score > best.score) best = { client, score };
    }
    if (!best || best.score < 0.5) return null;
    return {
      ndid: best.client.ndid,
      hotelName: best.client.hotelName,
      why: best.score === 1 ? "same name" : "similar name",
    };
  }

  /** "The Green Castle Resort Pvt. Ltd." → ["green", "castle"] */
  static words(name: string): string[] {
    return name
      .toLowerCase()
      .replace(/&/g, " and ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !FILLER.has(w));
  }

  private async clients(admin: AdminRecord): Promise<ProfileRecord[]> {
    const scope = AdminPermissions.propertyScope(admin);
    const out: ProfileRecord[] = [];
    let after: string | undefined;
    do {
      const page = await this.profiles.list({
        limit: CLIENT_PAGE,
        ...(after ? { after } : {}),
        ...(scope ? { ndids: [...scope.keys()] } : {}),
      });
      out.push(...page.items);
      after = page.nextCursor ?? undefined;
    } while (after && out.length < MAX_CLIENTS);
    return out;
  }

  private async visibleClient(admin: AdminRecord, ndid: string): Promise<ProfileRecord> {
    const scope = AdminPermissions.propertyScope(admin);
    if (scope && !scope.has(ndid)) throw new ClientNotFoundError();
    const profile = await this.profiles.findByNdid(ndid);
    if (!profile) throw new ClientNotFoundError();
    return profile;
  }

  private log(
    admin: AdminRecord,
    action: AdminAuditAction,
    ndid: string | null,
    details: Record<string, unknown> | null,
    ip?: string,
  ) {
    return this.audit.record({ action, actorId: admin.id, actorEmail: admin.email, targetId: ndid, details, ip });
  }
}
