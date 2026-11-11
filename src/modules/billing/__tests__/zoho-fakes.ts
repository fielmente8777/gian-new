import type {
  NewZohoInvoice,
  ZohoAccess,
  ZohoBooksApi,
  ZohoContact,
  ZohoInvoice,
  ZohoTokens,
} from "../../../integrations/zoho/zoho-books.client.js";
import type {
  PaymentSetup,
  ZohoConnection,
  ZohoCustomerLink,
  ZohoInvoiceRecord,
  ZohoStore,
} from "../types/zoho.types.js";

/** A valid 32-byte key, base64 */
export const TEST_ZOHO_KEY = Buffer.alloc(32, 7).toString("base64");
export const TEST_ZOHO_WEBHOOK_TOKEN = "zoho-webhook-token-for-tests-only";

export class InMemoryZohoStore implements ZohoStore {
  conn: ZohoConnection | null = null;
  setup: PaymentSetup = { provider: "razorpay", changedBy: null, changedAt: null };
  readonly states = new Map<string, { by: string; expiresAt: Date }>();
  readonly linkRows = new Map<string, ZohoCustomerLink>();
  readonly invoiceRows = new Map<string, ZohoInvoiceRecord>();

  async connection() {
    return this.conn ? { ...this.conn } : null;
  }
  async saveConnection(connection: ZohoConnection) {
    this.conn = { ...connection };
  }
  async updateConnection(changes: Partial<ZohoConnection>) {
    if (this.conn) this.conn = { ...this.conn, ...changes };
  }
  async deleteConnection() {
    this.conn = null;
  }
  async paymentSetup() {
    return { ...this.setup };
  }
  async savePaymentSetup(setup: PaymentSetup) {
    this.setup = { ...setup };
  }
  async saveState(state: string, by: string, expiresAt: Date) {
    this.states.set(state, { by, expiresAt });
  }
  async takeState(state: string, now: Date) {
    const row = this.states.get(state);
    this.states.delete(state);
    return row && row.expiresAt > now ? row.by : null;
  }
  async links() {
    return [...this.linkRows.values()];
  }
  async linkByNdid(ndid: string) {
    return this.linkRows.get(ndid) ?? null;
  }
  async linkByContact(contactId: string) {
    return [...this.linkRows.values()].find((l) => l.contactId === contactId) ?? null;
  }
  async saveLink(link: ZohoCustomerLink) {
    for (const [ndid, l] of this.linkRows)
      if (ndid === link.ndid || l.contactId === link.contactId) this.linkRows.delete(ndid);
    this.linkRows.set(link.ndid, { ...link });
  }
  async deleteLink(ndid: string) {
    return this.linkRows.delete(ndid);
  }
  async invoice(invoiceId: string) {
    const row = this.invoiceRows.get(invoiceId);
    return row ? { ...row } : null;
  }
  async invoiceByOrder(orderId: string) {
    const row = [...this.invoiceRows.values()].find((i) => i.orderId === orderId);
    return row ? { ...row } : null;
  }
  async upsertInvoice(invoiceId: string, changes: Partial<ZohoInvoiceRecord>, now: Date) {
    const base: ZohoInvoiceRecord = this.invoiceRows.get(invoiceId) ?? {
      invoiceId,
      number: "",
      contactId: "",
      contactName: "",
      ndid: null,
      source: "zoho",
      orderId: null,
      status: "",
      totalPaise: 0,
      currency: "INR",
      invoiceUrl: null,
      invoiceDate: "",
      lines: [],
      appliedAt: null,
      ignoredAt: null,
      ignoredBy: null,
      createdAt: now,
      updatedAt: now,
    };
    const next = { ...base, ...changes, invoiceId, updatedAt: now };
    this.invoiceRows.set(invoiceId, next);
    return { ...next };
  }
  async invoices({ state, limit }: { state: "review" | "applied" | "open" | "all"; limit: number }) {
    return [...this.invoiceRows.values()]
      .filter((i) =>
        state === "review"
          ? i.status === "paid" && !i.appliedAt && !i.ignoredAt
          : state === "applied"
            ? i.appliedAt !== null
            : state === "open"
              ? !["paid", "void"].includes(i.status) && !i.appliedAt
              : true,
      )
      .slice(0, limit);
  }
}

/**
 * Zoho Books in memory: one organisation, customers, invoices with GST, and a sign-in that
 * accepts the code "good-code". `pay(invoiceId)` is what the hotel paying on Zoho does.
 */
export class FakeZohoBooks implements ZohoBooksApi {
  readonly contactsList: ZohoContact[] = [];
  readonly invoicesById = new Map<string, ZohoInvoice>();
  readonly created: NewZohoInvoice[] = [];
  readonly emailed: { invoiceId: string; to: string[] }[] = [];
  refreshes = 0;
  revoked: string[] = [];
  gstPercent = 18;
  private seq = 0;

  authorizeUrl(state: string, redirectUri: string) {
    return `https://accounts.zoho.test/oauth/v2/auth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  async exchangeCode(code: string): Promise<ZohoTokens> {
    if (code !== "good-code") throw new Error("invalid_code");
    return {
      accessToken: "access-1",
      refreshToken: "refresh-secret",
      expiresAt: new Date(Date.now() + 3_600_000),
      apiDomain: "https://zoho.test",
    };
  }
  async refresh(): Promise<ZohoTokens> {
    this.refreshes += 1;
    return {
      accessToken: `access-r${this.refreshes}`,
      refreshToken: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      apiDomain: "https://zoho.test",
    };
  }
  async revoke(refreshToken: string) {
    this.revoked.push(refreshToken);
  }
  async organizations() {
    return [{ id: "org-1", name: "Eazotel Technologies" }];
  }
  async taxes() {
    return [{ id: "tax-18", name: "GST18", percentage: 18 }];
  }
  async contacts(_t: ZohoAccess, _org: string, { search }: { page: number; search?: string }) {
    const items = this.contactsList.filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()));
    return { items, hasMore: false };
  }
  async createContact(
    _t: ZohoAccess,
    _org: string,
    input: { name: string; email: string | null; phone: string | null },
  ) {
    const contact: ZohoContact = {
      contactId: `c-${++this.seq}`,
      name: input.name,
      companyName: input.name,
      email: input.email,
      phone: input.phone,
      status: "active",
    };
    this.contactsList.push(contact);
    return contact;
  }
  async createInvoice(_t: ZohoAccess, _org: string, input: NewZohoInvoice) {
    this.created.push(input);
    const subtotal = input.lineItems.reduce((s, l) => s + l.rate * l.quantity, 0) - input.discount;
    const tax = input.lineItems.some((l) => l.taxId) ? (subtotal * this.gstPercent) / 100 : 0;
    const total = Math.round((subtotal + tax) * 100) / 100;
    const contact = this.contactsList.find((c) => c.contactId === input.customerId);
    const invoice: ZohoInvoice = {
      invoiceId: `inv-${++this.seq}`,
      number: `INV-${String(this.seq).padStart(5, "0")}`,
      status: "draft",
      customerId: input.customerId,
      customerName: contact?.name ?? "",
      referenceNumber: input.referenceNumber,
      total,
      balance: total,
      currencyCode: "INR",
      date: input.date,
      invoiceUrl: null,
      lineItems: input.lineItems.map((l) => ({
        name: l.name,
        description: l.description,
        rate: l.rate,
        quantity: l.quantity,
        itemTotal: l.rate * l.quantity,
      })),
      lastPaymentDate: null,
    };
    this.invoicesById.set(invoice.invoiceId, invoice);
    return { ...invoice };
  }
  async markSent(_t: ZohoAccess, _org: string, invoiceId: string) {
    const inv = this.invoicesById.get(invoiceId)!;
    inv.status = "sent";
    inv.invoiceUrl = `https://books.zoho.test/portal/invoice/${invoiceId}`;
  }
  async emailInvoice(_t: ZohoAccess, _org: string, invoiceId: string, to: string[]) {
    this.emailed.push({ invoiceId, to });
  }
  async invoice(_t: ZohoAccess, _org: string, invoiceId: string) {
    const inv = this.invoicesById.get(invoiceId);
    return inv ? { ...inv } : null;
  }
  async recentlyPaid() {
    return {
      items: [...this.invoicesById.values()].filter((i) => i.status === "paid").map((i) => ({ ...i })),
      hasMore: false,
    };
  }

  /** The hotel pays on Zoho's page. */
  pay(invoiceId: string) {
    const inv = this.invoicesById.get(invoiceId)!;
    inv.status = "paid";
    inv.balance = 0;
    inv.lastPaymentDate = "2026-11-11";
  }

  /** An invoice the team made in Zoho Books by hand, already paid. */
  addPaidByHand(customerId: string, total: number, line = "Eazotel PRO - 12 months") {
    const contact = this.contactsList.find((c) => c.contactId === customerId);
    const invoice: ZohoInvoice = {
      invoiceId: `hand-${++this.seq}`,
      number: `INV-H${this.seq}`,
      status: "paid",
      customerId,
      customerName: contact?.name ?? "",
      referenceNumber: "",
      total,
      balance: 0,
      currencyCode: "INR",
      date: "2026-11-10",
      invoiceUrl: `https://books.zoho.test/portal/invoice/hand-${this.seq}`,
      lineItems: [{ name: line, description: "", rate: total, quantity: 1, itemTotal: total }],
      lastPaymentDate: "2026-11-10",
    };
    this.invoicesById.set(invoice.invoiceId, invoice);
    return invoice;
  }
}
