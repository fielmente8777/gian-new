import { z } from "zod";

const TIMEOUT_MS = 20_000;
/** Zoho Books' own limit per list page */
const PAGE_SIZE = 200;

export interface ZohoTokens {
  accessToken: string;
  /** only on the first exchange; Zoho never sends it again */
  refreshToken: string | null;
  expiresAt: Date;
  /** e.g. https://www.zohoapis.in, where this account's API lives */
  apiDomain: string;
}

export interface ZohoContact {
  contactId: string;
  name: string;
  companyName: string;
  email: string | null;
  phone: string | null;
  status: string;
}

export interface ZohoInvoice {
  invoiceId: string;
  number: string;
  /** draft, sent, overdue, partially_paid, paid, void… */
  status: string;
  customerId: string;
  customerName: string;
  referenceNumber: string;
  /** rupees, GST included */
  total: number;
  balance: number;
  currencyCode: string;
  date: string;
  /** the customer's page to see and pay it (once the invoice is sent) */
  invoiceUrl: string | null;
  lineItems: { name: string; description: string; rate: number; quantity: number; itemTotal: number }[];
  lastPaymentDate: string | null;
}

export interface NewZohoInvoice {
  customerId: string;
  referenceNumber: string;
  /** YYYY-MM-DD */
  date: string;
  dueDate: string;
  lineItems: { name: string; description: string; rate: number; quantity: number; taxId: string | null }[];
  /** rupees off the whole invoice, before tax (billing-cycle discount, offer, credit) */
  discount: number;
  notes: string;
}

/** What billing needs from Zoho Books; tests use a fake. All calls are for one organisation. */
export interface ZohoBooksApi {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<ZohoTokens>;
  refresh(refreshToken: string): Promise<ZohoTokens>;
  revoke(refreshToken: string): Promise<void>;
  organizations(token: ZohoAccess): Promise<{ id: string; name: string }[]>;
  taxes(token: ZohoAccess, orgId: string): Promise<{ id: string; name: string; percentage: number }[]>;
  contacts(
    token: ZohoAccess,
    orgId: string,
    query: { page: number; search?: string },
  ): Promise<{ items: ZohoContact[]; hasMore: boolean }>;
  createContact(
    token: ZohoAccess,
    orgId: string,
    input: { name: string; email: string | null; phone: string | null; gstin: string | null },
  ): Promise<ZohoContact>;
  createInvoice(token: ZohoAccess, orgId: string, input: NewZohoInvoice): Promise<ZohoInvoice>;
  markSent(token: ZohoAccess, orgId: string, invoiceId: string): Promise<void>;
  emailInvoice(token: ZohoAccess, orgId: string, invoiceId: string, to: string[]): Promise<void>;
  invoice(token: ZohoAccess, orgId: string, invoiceId: string): Promise<ZohoInvoice | null>;
  /** paid invoices, most recently changed first */
  recentlyPaid(token: ZohoAccess, orgId: string, page: number): Promise<{ items: ZohoInvoice[]; hasMore: boolean }>;
}

/** A usable access token and the API domain it belongs to. */
export interface ZohoAccess {
  accessToken: string;
  apiDomain: string;
}

/** Zoho's answer when it refuses a call, with Zoho's own message. */
export class ZohoError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly zohoCode: number | null,
  ) {
    super(message);
    this.name = "ZohoError";
  }
}

const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.coerce.number(),
  api_domain: z.string().optional(),
  error: z.string().optional(),
});
const pageContext = z.object({ has_more_page: z.boolean().optional() }).optional();
const contactSchema = z.object({
  contact_id: z.coerce.string(),
  contact_name: z.string().default(""),
  company_name: z.string().default(""),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  mobile: z.string().nullish(),
  status: z.string().default("active"),
});
const invoiceSchema = z.object({
  invoice_id: z.coerce.string(),
  invoice_number: z.string().default(""),
  status: z.string().default(""),
  customer_id: z.coerce.string().default(""),
  customer_name: z.string().default(""),
  reference_number: z.string().nullish(),
  total: z.coerce.number().default(0),
  balance: z.coerce.number().default(0),
  currency_code: z.string().default("INR"),
  date: z.string().default(""),
  invoice_url: z.string().nullish(),
  last_payment_date: z.string().nullish(),
  line_items: z
    .array(
      z.object({
        name: z.string().nullish(),
        description: z.string().nullish(),
        rate: z.coerce.number().default(0),
        quantity: z.coerce.number().default(1),
        item_total: z.coerce.number().default(0),
      }),
    )
    .default([]),
});

/**
 * Zoho Books v3 over fetch (no SDK), with Zoho's OAuth: one connection for Eazotel's own
 * organisation, made once by a super admin from the admin console. Every answer is checked
 * with zod before it is used. Amounts are rupees, as Zoho keeps them.
 */
export class ZohoBooksClient implements ZohoBooksApi {
  constructor(
    private readonly config: { clientId: string; clientSecret: string; accountsUrl: string; apiUrl: string },
  ) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      scope: "ZohoBooks.fullaccess.all",
      client_id: this.config.clientId,
      response_type: "code",
      // offline + consent: Zoho gives a refresh token, so the connection outlives the hour
      access_type: "offline",
      prompt: "consent",
      redirect_uri: redirectUri,
      state,
    });
    return `${this.base(this.config.accountsUrl)}/oauth/v2/auth?${params}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<ZohoTokens> {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  async refresh(refreshToken: string): Promise<ZohoTokens> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async revoke(refreshToken: string): Promise<void> {
    await fetch(
      `${this.base(this.config.accountsUrl)}/oauth/v2/token/revoke?${new URLSearchParams({ token: refreshToken })}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  }

  async organizations(token: ZohoAccess) {
    const body = await this.call(token, "GET", "/organizations", null);
    const orgs = z
      .object({ organizations: z.array(z.object({ organization_id: z.coerce.string(), name: z.string() })) })
      .parse(body);
    return orgs.organizations.map((o) => ({ id: o.organization_id, name: o.name }));
  }

  async taxes(token: ZohoAccess, orgId: string) {
    const body = await this.call(token, "GET", "/settings/taxes", orgId);
    const parsed = z
      .object({
        taxes: z
          .array(z.object({ tax_id: z.coerce.string(), tax_name: z.string(), tax_percentage: z.coerce.number() }))
          .default([]),
      })
      .parse(body);
    return parsed.taxes.map((t) => ({ id: t.tax_id, name: t.tax_name, percentage: t.tax_percentage }));
  }

  async contacts(token: ZohoAccess, orgId: string, { page, search }: { page: number; search?: string }) {
    const query = {
      page: String(page),
      per_page: String(PAGE_SIZE),
      contact_type: "customer",
      ...(search ? { search_text: search } : {}),
    };
    const body = await this.call(token, "GET", "/contacts", orgId, query);
    const parsed = z.object({ contacts: z.array(contactSchema).default([]), page_context: pageContext }).parse(body);
    return {
      items: parsed.contacts.map((c) => ZohoBooksClient.contact(c)),
      hasMore: parsed.page_context?.has_more_page === true,
    };
  }

  async createContact(
    token: ZohoAccess,
    orgId: string,
    input: { name: string; email: string | null; phone: string | null; gstin: string | null },
  ) {
    const body = await this.call(
      token,
      "POST",
      "/contacts",
      orgId,
      {},
      {
        contact_name: input.name,
        company_name: input.name,
        contact_type: "customer",
        ...(input.gstin ? { gst_treatment: "business_gst", gst_no: input.gstin } : { gst_treatment: "consumer" }),
        ...(input.email || input.phone
          ? {
              contact_persons: [
                {
                  first_name: input.name.slice(0, 100),
                  email: input.email ?? "",
                  phone: input.phone ?? "",
                  is_primary_contact: true,
                },
              ],
            }
          : {}),
      },
    );
    return ZohoBooksClient.contact(z.object({ contact: contactSchema }).parse(body).contact);
  }

  async createInvoice(token: ZohoAccess, orgId: string, input: NewZohoInvoice) {
    const body = await this.call(
      token,
      "POST",
      "/invoices",
      orgId,
      {},
      {
        customer_id: input.customerId,
        reference_number: input.referenceNumber,
        date: input.date,
        due_date: input.dueDate,
        notes: input.notes,
        is_inclusive_tax: false,
        ...(input.discount > 0
          ? { discount: input.discount, discount_type: "entity_level", is_discount_before_tax: true }
          : {}),
        line_items: input.lineItems.map((l) => ({
          name: l.name,
          description: l.description,
          rate: l.rate,
          quantity: l.quantity,
          ...(l.taxId ? { tax_id: l.taxId } : {}),
        })),
      },
    );
    return ZohoBooksClient.invoice(z.object({ invoice: invoiceSchema }).parse(body).invoice);
  }

  async markSent(token: ZohoAccess, orgId: string, invoiceId: string) {
    await this.call(token, "POST", `/invoices/${encodeURIComponent(invoiceId)}/status/sent`, orgId);
  }

  async emailInvoice(token: ZohoAccess, orgId: string, invoiceId: string, to: string[]) {
    await this.call(token, "POST", `/invoices/${encodeURIComponent(invoiceId)}/email`, orgId, {}, { to_mail_ids: to });
  }

  async invoice(token: ZohoAccess, orgId: string, invoiceId: string) {
    try {
      const body = await this.call(token, "GET", `/invoices/${encodeURIComponent(invoiceId)}`, orgId);
      return ZohoBooksClient.invoice(z.object({ invoice: invoiceSchema }).parse(body).invoice);
    } catch (err) {
      if (err instanceof ZohoError && err.status === 404) return null;
      throw err;
    }
  }

  async recentlyPaid(token: ZohoAccess, orgId: string, page: number) {
    const body = await this.call(token, "GET", "/invoices", orgId, {
      status: "paid",
      sort_column: "last_modified_time",
      sort_order: "D",
      page: String(page),
      per_page: String(PAGE_SIZE),
    });
    const parsed = z.object({ invoices: z.array(invoiceSchema).default([]), page_context: pageContext }).parse(body);
    return {
      items: parsed.invoices.map((i) => ZohoBooksClient.invoice(i)),
      hasMore: parsed.page_context?.has_more_page === true,
    };
  }

  private async token(params: Record<string, string>): Promise<ZohoTokens> {
    const query = new URLSearchParams({
      ...params,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const res = await fetch(`${this.base(this.config.accountsUrl)}/oauth/v2/token?${query}`, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => ({}));
    const raw = body as { error?: string };
    // Zoho answers 200 with { error: "invalid_code" } for a bad or reused code
    if (!res.ok || raw.error) throw new ZohoError(res.status, `Zoho sign-in failed: ${raw.error ?? res.status}`, null);
    const t = tokenSchema.parse(body);
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: new Date(Date.now() + (t.expires_in - 60) * 1000),
      apiDomain: t.api_domain ?? this.config.apiUrl,
    };
  }

  private async call(
    token: ZohoAccess,
    method: "GET" | "POST",
    path: string,
    orgId: string | null,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<unknown> {
    const params = new URLSearchParams({ ...(orgId ? { organization_id: orgId } : {}), ...query });
    const res = await fetch(`${this.base(token.apiDomain)}/books/v3${path}${params.size ? `?${params}` : ""}`, {
      method,
      headers: {
        authorization: `Zoho-oauthtoken ${token.accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json: unknown = await res.json().catch(() => ({}));
    const reply = json as { code?: number; message?: string };
    // Zoho Books: code 0 = success, anything else is an error even with a 200
    if (!res.ok || (typeof reply.code === "number" && reply.code !== 0)) {
      throw new ZohoError(res.status, reply.message ?? `Zoho Books answered ${res.status}`, reply.code ?? null);
    }
    return json;
  }

  private base(url: string): string {
    return url.replace(/\/+$/, "");
  }

  private static contact(c: z.infer<typeof contactSchema>): ZohoContact {
    return {
      contactId: c.contact_id,
      name: c.contact_name,
      companyName: c.company_name,
      email: c.email || null,
      phone: c.mobile || c.phone || null,
      status: c.status,
    };
  }

  private static invoice(i: z.infer<typeof invoiceSchema>): ZohoInvoice {
    return {
      invoiceId: i.invoice_id,
      number: i.invoice_number,
      status: i.status,
      customerId: i.customer_id,
      customerName: i.customer_name,
      referenceNumber: i.reference_number ?? "",
      total: i.total,
      balance: i.balance,
      currencyCode: i.currency_code,
      date: i.date,
      invoiceUrl: i.invoice_url || null,
      lineItems: i.line_items.map((l) => ({
        name: l.name ?? "",
        description: l.description ?? "",
        rate: l.rate,
        quantity: l.quantity,
        itemTotal: l.item_total,
      })),
      lastPaymentDate: i.last_payment_date ?? null,
    };
  }
}
