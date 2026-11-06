import { randomUUID } from "node:crypto";

import mongoose, { type Types } from "mongoose";

import type {
  ClientArchivePort,
  CollectionCount,
  DeletionMeta,
  DeletionPreview,
  DeletionResult,
} from "../types/client-archive.types.js";

/** The fields nexon, gian and gian-new use to say which client a record belongs to. */
const CLIENT_FIELDS = ["ndid", "uId", "NDID"] as const;

/** Never searched: staff data, shared catalogues, the archive itself, and login records (handled by user id). */
const SKIP = new Set([
  "admin_users",
  "admin_audit_logs",
  "admin_login_challenges",
  "deleted_clients",
  "deleted_client_records",
  "plans",
  "apps",
  "auth_credentials",
  "auth_refresh_tokens",
]);

/** Snapshots someone took by hand (e.g. Eazbot_backup_2026_10_21) stay as they were. */
const BACKUP = /backup/i;

/** Login records point at the hotel's users (Zucks_users) by user id, not by ndid. */
const BY_USER_ID = ["auth_credentials", "auth_refresh_tokens"];

const BATCH = 500;
const COLLECTION_LIST_MS = 5 * 60_000;

const byClient = (ndid: string) => ({ $or: CLIENT_FIELDS.map((field) => ({ [field]: ndid })) });

/**
 * Searches every collection, so data from any service (nexon, gian, gian-new) is found without
 * keeping a list of collections in step. Each batch is copied to deleted_client_records before
 * it is deleted, so a stop half-way leaves records archived, never lost.
 */
export class ClientArchiveRepository implements ClientArchivePort {
  private names: { at: number; list: string[] } | null = null;

  async preview(ndid: string): Promise<DeletionPreview> {
    const collections = await this.searchable();
    const counts = await Promise.all(
      collections.map(async (collection) => ({
        collection,
        count: await mongoose.connection.collection(collection).countDocuments(byClient(ndid)),
      })),
    );
    const userIds = await this.userIds(ndid);
    for (const collection of BY_USER_ID) {
      const count = userIds.length
        ? await mongoose.connection.collection(collection).countDocuments({ userId: { $in: userIds } })
        : 0;
      counts.push({ collection, count });
    }
    return ClientArchiveRepository.summary(ndid, counts);
  }

  async archiveAndDelete(ndid: string, meta: DeletionMeta): Promise<DeletionResult> {
    const deletionId = randomUUID();
    const deletedAt = new Date();
    // read before Zucks_users goes, or the login records could no longer be matched
    const userIds = await this.userIds(ndid);

    const counts: CollectionCount[] = [];
    for (const collection of await this.searchable()) {
      counts.push({ collection, count: await this.move(collection, byClient(ndid), { deletionId, ndid, deletedAt }) });
    }
    for (const collection of BY_USER_ID) {
      const count = userIds.length
        ? await this.move(collection, { userId: { $in: userIds } }, { deletionId, ndid, deletedAt })
        : 0;
      counts.push({ collection, count });
    }
    // staff who had this client's properties assigned no longer do
    await mongoose.connection
      .collection("admin_users")
      .updateMany({ "assignedProperties.ndid": ndid }, { $pull: { assignedProperties: { ndid } } } as never);

    const result = { ...ClientArchiveRepository.summary(ndid, counts), deletionId };
    await mongoose.connection.collection("deleted_clients").insertOne({
      deletionId,
      ndid,
      hotelName: meta.hotelName,
      by: meta.by,
      reason: meta.reason,
      collections: result.collections,
      total: result.total,
      deletedAt,
    });
    return result;
  }

  async ensureIndexes(): Promise<void> {
    await mongoose.connection.collection("deleted_client_records").createIndex({ deletionId: 1, collection: 1 });
    await mongoose.connection.collection("deleted_client_records").createIndex({ ndid: 1 });
    await mongoose.connection.collection("deleted_clients").createIndex({ ndid: 1, deletedAt: -1 });
  }

  /** Copies matching records to the archive, then deletes exactly those, in batches. */
  private async move(
    collection: string,
    filter: Record<string, unknown>,
    tag: { deletionId: string; ndid: string; deletedAt: Date },
  ): Promise<number> {
    const source = mongoose.connection.collection(collection);
    const archive = mongoose.connection.collection("deleted_client_records");
    let moved = 0;
    for (;;) {
      const docs = await source.find(filter).limit(BATCH).toArray();
      if (docs.length === 0) return moved;
      await archive.insertMany(docs.map((doc) => ({ ...tag, collection, doc })));
      await source.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
      moved += docs.length;
    }
  }

  private async userIds(ndid: string): Promise<Types.ObjectId[]> {
    const users = await mongoose.connection
      .collection("Zucks_users")
      .find(byClient(ndid), { projection: { _id: 1 } })
      .toArray();
    return users.map((u) => u._id as Types.ObjectId);
  }

  private async searchable(): Promise<string[]> {
    if (this.names && Date.now() - this.names.at < COLLECTION_LIST_MS) return this.names.list;
    const all = await mongoose.connection.db!.listCollections({}, { nameOnly: true }).toArray();
    const list = all
      .filter((c) => c.type !== "view")
      .map((c) => c.name)
      .filter((name) => !name.startsWith("system.") && !SKIP.has(name) && !BACKUP.test(name))
      .sort();
    this.names = { at: Date.now(), list };
    return list;
  }

  private static summary(ndid: string, counts: CollectionCount[]): DeletionPreview {
    const collections = counts
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count || a.collection.localeCompare(b.collection));
    return { ndid, collections, total: collections.reduce((sum, c) => sum + c.count, 0) };
  }
}
