import mongoose from "mongoose";

import type {
  PaymentSetup,
  ZohoConnection,
  ZohoCustomerLink,
  ZohoInvoiceRecord,
  ZohoStore,
} from "../types/zoho.types.js";

const CONNECTION_ID = "default";
const SETUP_ID = "payment_setup";

/**
 * zoho_connection (the connection and the payment setup, one document each), zoho_oauth_states,
 * zoho_customer_links and zoho_invoices. All new collections, owned by billing.
 */
export class ZohoRepository implements ZohoStore {
  private get settings() {
    return mongoose.connection.collection<{ _id: string } & Record<string, unknown>>("zoho_connection");
  }
  private get states() {
    return mongoose.connection.collection<{ state: string; by: string; expiresAt: Date }>("zoho_oauth_states");
  }
  private get linkRows() {
    return mongoose.connection.collection<ZohoCustomerLink>("zoho_customer_links");
  }
  private get invoiceRows() {
    return mongoose.connection.collection<ZohoInvoiceRecord>("zoho_invoices");
  }

  async ensureIndexes(): Promise<void> {
    await this.states.createIndex({ state: 1 }, { unique: true });
    await this.states.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.linkRows.createIndex({ ndid: 1 }, { unique: true });
    await this.linkRows.createIndex({ contactId: 1 }, { unique: true });
    await this.invoiceRows.createIndex({ invoiceId: 1 }, { unique: true });
    await this.invoiceRows.createIndex({ orderId: 1 }, { sparse: true });
    await this.invoiceRows.createIndex({ appliedAt: 1, status: 1, updatedAt: -1 });
  }

  async connection(): Promise<ZohoConnection | null> {
    const doc = await this.settings.findOne({ _id: CONNECTION_ID });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest as unknown as ZohoConnection;
  }

  async saveConnection(connection: ZohoConnection): Promise<void> {
    await this.settings.replaceOne({ _id: CONNECTION_ID }, { _id: CONNECTION_ID, ...connection }, { upsert: true });
  }

  async updateConnection(changes: Partial<ZohoConnection>): Promise<void> {
    await this.settings.updateOne({ _id: CONNECTION_ID }, { $set: changes });
  }

  async deleteConnection(): Promise<void> {
    await this.settings.deleteOne({ _id: CONNECTION_ID });
  }

  async paymentSetup(): Promise<PaymentSetup> {
    const doc = await this.settings.findOne({ _id: SETUP_ID });
    return {
      provider: doc?.provider === "zoho" ? "zoho" : "razorpay",
      changedBy: (doc?.changedBy as string | undefined) ?? null,
      changedAt: (doc?.changedAt as Date | undefined) ?? null,
    };
  }

  async savePaymentSetup(setup: PaymentSetup): Promise<void> {
    await this.settings.updateOne({ _id: SETUP_ID }, { $set: { ...setup } }, { upsert: true });
  }

  async saveState(state: string, by: string, expiresAt: Date): Promise<void> {
    await this.states.insertOne({ state, by, expiresAt });
  }

  async takeState(state: string, now: Date): Promise<string | null> {
    const doc = await this.states.findOneAndDelete({ state });
    return doc && doc.expiresAt > now ? doc.by : null;
  }

  async links(): Promise<ZohoCustomerLink[]> {
    return (await this.linkRows.find({}).sort({ contactName: 1 }).toArray()).map(ZohoRepository.strip);
  }

  async linkByNdid(ndid: string): Promise<ZohoCustomerLink | null> {
    const doc = await this.linkRows.findOne({ ndid });
    return doc ? ZohoRepository.strip(doc) : null;
  }

  async linkByContact(contactId: string): Promise<ZohoCustomerLink | null> {
    const doc = await this.linkRows.findOne({ contactId });
    return doc ? ZohoRepository.strip(doc) : null;
  }

  async saveLink(link: ZohoCustomerLink): Promise<void> {
    // one client ↔ one Zoho customer: drop whatever either side was linked to before
    await this.linkRows.deleteMany({ $or: [{ ndid: link.ndid }, { contactId: link.contactId }] });
    await this.linkRows.insertOne({ ...link });
  }

  async deleteLink(ndid: string): Promise<boolean> {
    return (await this.linkRows.deleteOne({ ndid })).deletedCount === 1;
  }

  async invoice(invoiceId: string): Promise<ZohoInvoiceRecord | null> {
    const doc = await this.invoiceRows.findOne({ invoiceId });
    return doc ? ZohoRepository.strip(doc) : null;
  }

  async invoiceByOrder(orderId: string): Promise<ZohoInvoiceRecord | null> {
    const doc = await this.invoiceRows.findOne({ orderId });
    return doc ? ZohoRepository.strip(doc) : null;
  }

  async upsertInvoice(invoiceId: string, changes: Partial<ZohoInvoiceRecord>, now: Date): Promise<ZohoInvoiceRecord> {
    const defaults: Partial<ZohoInvoiceRecord> = {
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
    };
    // a field being set must not also be in $setOnInsert
    const onInsert = Object.fromEntries(Object.entries(defaults).filter(([k]) => !(k in changes)));
    const doc = await this.invoiceRows.findOneAndUpdate(
      { invoiceId },
      { $set: { ...changes, updatedAt: now }, $setOnInsert: { ...onInsert, invoiceId, createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    return ZohoRepository.strip(doc!);
  }

  async invoices({
    state,
    limit,
  }: {
    state: "review" | "applied" | "open" | "all";
    limit: number;
  }): Promise<ZohoInvoiceRecord[]> {
    const filter =
      state === "review"
        ? { status: "paid", appliedAt: null, ignoredAt: null }
        : state === "applied"
          ? { appliedAt: { $ne: null } }
          : state === "open"
            ? { status: { $nin: ["paid", "void"] }, appliedAt: null }
            : {};
    return (await this.invoiceRows.find(filter).sort({ updatedAt: -1 }).limit(limit).toArray()).map(
      ZohoRepository.strip,
    );
  }

  private static strip<T extends { _id?: unknown }>(doc: T): Omit<T, "_id"> {
    const { _id, ...rest } = doc;
    return rest;
  }
}
