/** Where hotels pay: Razorpay in the dashboard (default) or a Zoho Books invoice. */
export type PaymentProvider = "razorpay" | "zoho";

/** The one Zoho Books connection (zoho_connection `_id: "default"`). */
export interface ZohoConnection {
  orgId: string;
  orgName: string;
  /** AES-256-GCM, see TokenCipher; never sent to a browser */
  refreshTokenEnc: string;
  accessToken: string | null;
  accessExpiresAt: Date | null;
  apiDomain: string;
  /** Zoho's GST tax put on every invoice line (e.g. "GST18"); null = no tax line */
  taxId: string | null;
  taxName: string | null;
  connectedBy: string;
  connectedAt: Date;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
}

/** Payment setup (zoho_connection `_id: "payment_setup"`): which way hotels pay now. */
export interface PaymentSetup {
  provider: PaymentProvider;
  changedBy: string | null;
  changedAt: Date | null;
}

/** A Zoho Books customer tied to a client (zoho_customer_links), one each way. */
export interface ZohoCustomerLink {
  ndid: string;
  contactId: string;
  contactName: string;
  linkedBy: string;
  linkedAt: Date;
}

/**
 * A Zoho Books invoice we know about (zoho_invoices), unique by invoiceId.
 * - source checkout: we made it (dashboard pay button or the admin console); `orderId` is its
 *   payment, applied by the same code as a Razorpay payment once Zoho says it's paid;
 * - source zoho: the team made it in Zoho Books; staff confirm which plan it pays for, then it
 *   is applied the same way.
 */
export interface ZohoInvoiceRecord {
  invoiceId: string;
  number: string;
  contactId: string;
  contactName: string;
  /** the client, once known (from the link or when staff apply it) */
  ndid: string | null;
  source: "checkout" | "zoho";
  /** our payments.orderId; set from the start for checkout invoices, on apply for the others */
  orderId: string | null;
  status: string;
  totalPaise: number;
  currency: string;
  invoiceUrl: string | null;
  invoiceDate: string;
  /** what it was for, as Zoho lists it */
  lines: string[];
  /** set once the subscription was updated for it */
  appliedAt: Date | null;
  /** staff said it isn't a subscription payment (e.g. a website build) */
  ignoredAt: Date | null;
  ignoredBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ZohoStore {
  connection(): Promise<ZohoConnection | null>;
  saveConnection(connection: ZohoConnection): Promise<void>;
  updateConnection(changes: Partial<ZohoConnection>): Promise<void>;
  deleteConnection(): Promise<void>;

  paymentSetup(): Promise<PaymentSetup>;
  savePaymentSetup(setup: PaymentSetup): Promise<void>;

  /** a one-time `state` for Zoho's sign-in, so the callback can't be forged */
  saveState(state: string, by: string, expiresAt: Date): Promise<void>;
  /** the email that started it, once; null when unknown or expired */
  takeState(state: string, now: Date): Promise<string | null>;

  links(): Promise<ZohoCustomerLink[]>;
  linkByNdid(ndid: string): Promise<ZohoCustomerLink | null>;
  linkByContact(contactId: string): Promise<ZohoCustomerLink | null>;
  /** replaces any link of this client or this contact */
  saveLink(link: ZohoCustomerLink): Promise<void>;
  deleteLink(ndid: string): Promise<boolean>;

  invoice(invoiceId: string): Promise<ZohoInvoiceRecord | null>;
  invoiceByOrder(orderId: string): Promise<ZohoInvoiceRecord | null>;
  /** inserts or updates by invoiceId; fields not given keep their value */
  upsertInvoice(invoiceId: string, changes: Partial<ZohoInvoiceRecord>, now: Date): Promise<ZohoInvoiceRecord>;
  invoices(query: { state: "review" | "applied" | "open" | "all"; limit: number }): Promise<ZohoInvoiceRecord[]>;
}
