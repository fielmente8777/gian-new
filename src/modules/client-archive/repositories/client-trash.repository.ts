import mongoose from "mongoose";

import type { ClientTrashPort, TrashedClient } from "../types/client-archive.types.js";

interface TrashDocument extends TrashedClient {
  _id?: unknown;
}

/** One document per trashed client in client_trash, unique by ndid. */
export class ClientTrashRepository implements ClientTrashPort {
  private get collection() {
    return mongoose.connection.collection<TrashDocument>("client_trash");
  }

  async add(client: TrashedClient): Promise<boolean> {
    const result = await this.collection.updateOne(
      { ndid: client.ndid },
      { $setOnInsert: { ...client } },
      { upsert: true },
    );
    return result.upsertedCount === 1;
  }

  async remove(ndid: string): Promise<TrashedClient | null> {
    const doc = await this.collection.findOneAndDelete({ ndid });
    return doc ? ClientTrashRepository.toRecord(doc) : null;
  }

  async find(ndid: string): Promise<TrashedClient | null> {
    const doc = await this.collection.findOne({ ndid });
    return doc ? ClientTrashRepository.toRecord(doc) : null;
  }

  async list(): Promise<TrashedClient[]> {
    const docs = await this.collection.find({}).sort({ trashedAt: -1 }).toArray();
    return docs.map((doc) => ClientTrashRepository.toRecord(doc));
  }

  async ndids(): Promise<string[]> {
    return (await this.collection.find({}, { projection: { ndid: 1 } }).toArray()).map((d) => d.ndid);
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ ndid: 1 }, { unique: true });
  }

  private static toRecord(doc: TrashDocument): TrashedClient {
    return {
      ndid: doc.ndid,
      hotelName: doc.hotelName ?? null,
      by: doc.by,
      reason: doc.reason ?? null,
      trashedAt: doc.trashedAt,
      pausedSubscription: doc.pausedSubscription === true,
    };
  }
}
