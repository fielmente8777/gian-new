import mongoose, { Types } from "mongoose";

import { ObjectIds } from "../../../shared/database/object-id.js";
import type { NewOffer, Offer, OfferStore } from "../types/billing.types.js";

interface OfferDoc extends Omit<Offer, "id"> {
  _id: Types.ObjectId;
}

/** `billing_offers`: discount codes staff create in the admin console. Owned by billing. */
export class OfferRepository implements OfferStore {
  private get collection() {
    return mongoose.connection.collection<OfferDoc>("billing_offers");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ code: 1 }, { unique: true });
  }

  async list(): Promise<Offer[]> {
    const docs = await this.collection.find({}).sort({ createdAt: -1 }).toArray();
    return docs.map(OfferRepository.toOffer);
  }

  async byId(id: string): Promise<Offer | null> {
    const _id = ObjectIds.parse(id);
    const doc = _id ? await this.collection.findOne({ _id }) : null;
    return doc ? OfferRepository.toOffer(doc) : null;
  }

  async byCode(code: string): Promise<Offer | null> {
    const doc = await this.collection.findOne({ code: code.toUpperCase() });
    return doc ? OfferRepository.toOffer(doc) : null;
  }

  async create(input: NewOffer, now: Date): Promise<Offer> {
    const _id = new Types.ObjectId();
    await this.collection.insertOne({ _id, ...input, redemptions: 0, createdAt: now, updatedAt: now });
    return (await this.byId(String(_id)))!;
  }

  async update(id: string, changes: Partial<NewOffer>, now: Date): Promise<Offer | null> {
    const _id = ObjectIds.parse(id);
    if (!_id) return null;
    const result = await this.collection.updateOne({ _id }, { $set: { ...changes, updatedAt: now } });
    return result.matchedCount ? this.byId(id) : null;
  }

  async redeem(code: string): Promise<void> {
    await this.collection.updateOne({ code: code.toUpperCase() }, { $inc: { redemptions: 1 } });
  }

  private static toOffer({ _id, ...rest }: OfferDoc): Offer {
    return {
      ...rest,
      id: String(_id),
      planCodes: rest.planCodes ?? [],
      cycleMonths: rest.cycleMonths ?? [],
      kinds: rest.kinds ?? [],
      ndids: rest.ndids ?? [],
      redemptions: rest.redemptions ?? 0,
    };
  }
}
