import mongoose, { Types } from "mongoose";

import { ObjectIds } from "../../../shared/database/object-id.js";
import type { InvoiceRecord, InvoiceStore, NewInvoice } from "../types/billing.types.js";

interface InvoiceDoc extends Omit<InvoiceRecord, "id"> {
  _id: Types.ObjectId;
}

interface CounterDoc {
  _id: string;
  seq: number;
}

/**
 * `billing_invoices` (one per successful payment, never edited) and `billing_counters` (the
 * running number per financial year, taken atomically so two payments never share a number).
 * Owned by billing.
 */
export class InvoiceRepository implements InvoiceStore {
  private get invoices() {
    return mongoose.connection.collection<InvoiceDoc>("billing_invoices");
  }

  private get counters() {
    return mongoose.connection.collection<CounterDoc>("billing_counters");
  }

  async ensureIndexes(): Promise<void> {
    await this.invoices.createIndex({ orderId: 1 }, { unique: true });
    await this.invoices.createIndex({ number: 1 }, { unique: true });
    await this.invoices.createIndex({ ndid: 1, issuedAt: -1 });
  }

  async create(invoice: NewInvoice, numberFor: (seq: number) => string, yearKey: string): Promise<InvoiceRecord> {
    const existing = await this.byOrderId(invoice.orderId);
    if (existing) return existing;
    const counter = await this.counters.findOneAndUpdate(
      { _id: `invoice:${yearKey}` },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    const _id = new Types.ObjectId();
    try {
      await this.invoices.insertOne({ _id, ...invoice, number: numberFor(counter!.seq), emailedTo: [], lastEmailedAt: null });
    } catch (error) {
      // the browser and the webhook issued it at the same moment: the other one won
      if ((error as { code?: number }).code === 11000) {
        const winner = await this.byOrderId(invoice.orderId);
        if (winner) return winner;
      }
      throw error;
    }
    return (await this.byId(String(_id)))!;
  }

  async byId(id: string): Promise<InvoiceRecord | null> {
    const _id = ObjectIds.parse(id);
    const doc = _id ? await this.invoices.findOne({ _id }) : null;
    return doc ? InvoiceRepository.toRecord(doc) : null;
  }

  async byOrderId(orderId: string): Promise<InvoiceRecord | null> {
    const doc = await this.invoices.findOne({ orderId });
    return doc ? InvoiceRepository.toRecord(doc) : null;
  }

  async numbersFor(orderIds: string[]): Promise<Map<string, { id: string; number: string }>> {
    if (orderIds.length === 0) return new Map();
    const docs = await this.invoices
      .find({ orderId: { $in: orderIds } }, { projection: { orderId: 1, number: 1 } })
      .toArray();
    return new Map(docs.map((d) => [d.orderId, { id: String(d._id), number: d.number }]));
  }

  async markEmailed(id: string, to: string[], at: Date): Promise<void> {
    const _id = ObjectIds.parse(id);
    if (_id) await this.invoices.updateOne({ _id }, { $addToSet: { emailedTo: { $each: to } }, $set: { lastEmailedAt: at } });
  }

  private static toRecord({ _id, ...rest }: InvoiceDoc): InvoiceRecord {
    return { ...rest, id: String(_id) };
  }
}
