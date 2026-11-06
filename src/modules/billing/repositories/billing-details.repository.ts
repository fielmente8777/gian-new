import mongoose from "mongoose";

import type { BillingDetails, BillingDetailsStore } from "../types/billing.types.js";

interface DetailsDoc extends BillingDetails {
  ndid: string;
  updatedAt: Date;
}

/** `billing_profiles`: the name, GSTIN and address a hotel wants on its invoices. Owned by billing. */
export class BillingDetailsRepository implements BillingDetailsStore {
  private get collection() {
    return mongoose.connection.collection<DetailsDoc>("billing_profiles");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ ndid: 1 }, { unique: true });
  }

  async get(ndid: string): Promise<BillingDetails | null> {
    const doc = await this.collection.findOne({ ndid }, { projection: { _id: 0, ndid: 0, updatedAt: 0 } });
    return doc ?? null;
  }

  async save(ndid: string, details: BillingDetails, now: Date): Promise<void> {
    await this.collection.updateOne({ ndid }, { $set: { ...details, ndid, updatedAt: now } }, { upsert: true });
  }
}
