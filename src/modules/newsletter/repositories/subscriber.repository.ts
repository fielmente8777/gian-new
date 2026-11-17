import mongoose, { Types } from "mongoose";

import { ObjectIds } from "../../../shared/database/object-id.js";
import type {
  NewSubscriber,
  NewsletterStats,
  Subscriber,
  SubscriberFilter,
  SubscriberPage,
  SubscriberSource,
  SubscriberStatus,
  SubscriberStore,
  UnsubscribedBy,
} from "../types/newsletter.types.js";

/** A `Newsletters` document. nexon's website box writes only { ndid, email }; everything else is optional. */
interface SubscriberDoc {
  _id: Types.ObjectId;
  ndid: string;
  email: string;
  name?: string | null;
  status?: SubscriberStatus;
  source?: SubscriberSource;
  tags?: string[];
  subscribedAt?: Date;
  unsubscribedAt?: Date | null;
  unsubscribedBy?: UnsubscribedBy | null;
  unsubscribeReason?: string | null;
  updatedAt?: Date;
}

type Filter<T> = mongoose.mongo.Filter<T>;
type AnyBulkWriteOperation<T extends mongoose.mongo.Document> = mongoose.mongo.AnyBulkWriteOperation<T>;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `Newsletters`: the hotel's newsletter list. Shared with nexon, whose /editnewsletter still
 * inserts { ndid, email } until nginx sends that path here. A row without `status` is subscribed,
 * one without `subscribedAt` was added when its _id was made.
 */
export class SubscriberRepository implements SubscriberStore {
  private get collection() {
    return mongoose.connection.collection<SubscriberDoc>("Newsletters");
  }

  /**
   * The unique { ndid, email } index needs the old duplicate rows merged first
   * (scripts/migrate-newsletters.ts). Until then a plain index is used and a warning returned.
   */
  async ensureIndexes(): Promise<string | null> {
    await this.collection.createIndex({ ndid: 1, status: 1, subscribedAt: -1 });
    try {
      await this.collection.createIndex({ ndid: 1, email: 1 }, { unique: true, name: "ndid_email_unique" });
      return null;
    } catch {
      return "Newsletters has duplicate { ndid, email } rows: run scripts/migrate-newsletters.ts to merge them";
    }
  }

  async list(ndid: string, filter: SubscriberFilter, page: number, limit: number): Promise<SubscriberPage> {
    const query = SubscriberRepository.query(ndid, filter);
    const [docs, total] = await Promise.all([
      this.collection
        .find(query)
        .sort({ subscribedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      this.collection.countDocuments(query),
    ]);
    return { items: docs.map(SubscriberRepository.toSubscriber), total, page, limit };
  }

  async all(ndid: string, filter: SubscriberFilter): Promise<Subscriber[]> {
    const docs = await this.collection
      .find(SubscriberRepository.query(ndid, filter))
      .sort({ subscribedAt: -1, _id: -1 })
      .toArray();
    return docs.map(SubscriberRepository.toSubscriber);
  }

  async byId(ndid: string, id: string): Promise<Subscriber | null> {
    const _id = ObjectIds.parse(id);
    const doc = _id ? await this.collection.findOne({ _id, ndid }) : null;
    return doc ? SubscriberRepository.toSubscriber(doc) : null;
  }

  async byEmail(ndid: string, email: string): Promise<Subscriber | null> {
    // case-insensitive: rows nexon saved before the migration keep the case typed on the website
    const doc = await this.collection.findOne({
      ndid,
      email: { $regex: `^${escapeRegex(email)}$`, $options: "i" },
    });
    return doc ? SubscriberRepository.toSubscriber(doc) : null;
  }

  async byEmails(ndid: string, emails: string[]): Promise<Subscriber[]> {
    if (!emails.length) return [];
    const docs = await this.collection.find({ ndid, email: { $in: emails.map((e) => e.toLowerCase()) } }).toArray();
    return docs.map(SubscriberRepository.toSubscriber);
  }

  async insert(
    ndid: string,
    input: NewSubscriber & { source: SubscriberSource; status?: SubscriberStatus },
    now: Date,
  ): Promise<Subscriber> {
    const status = input.status ?? "subscribed";
    const doc: SubscriberDoc = {
      _id: new Types.ObjectId(),
      ndid,
      email: input.email.toLowerCase(),
      name: input.name ?? null,
      status,
      source: input.source,
      tags: input.tags ?? [],
      subscribedAt: now,
      unsubscribedAt: status === "unsubscribed" ? now : null,
      unsubscribedBy: status === "unsubscribed" ? "subscriber" : null,
      unsubscribeReason: null,
      updatedAt: now,
    };
    await this.collection.insertOne(doc);
    return SubscriberRepository.toSubscriber(doc);
  }

  async update(
    ndid: string,
    id: string,
    changes: Partial<Omit<Subscriber, "id" | "ndid">>,
    now: Date,
  ): Promise<Subscriber | null> {
    const _id = ObjectIds.parse(id);
    if (!_id) return null;
    const doc = await this.collection.findOneAndUpdate(
      { _id, ndid },
      { $set: { ...changes, updatedAt: now } },
      { returnDocument: "after" },
    );
    return doc ? SubscriberRepository.toSubscriber(doc) : null;
  }

  async merge(
    ndid: string,
    rows: { email: string; name: string | null; tags: string[] }[],
    source: SubscriberSource,
    now: Date,
  ): Promise<{ added: number; updated: number }> {
    if (!rows.length) return { added: 0, updated: 0 };
    const operations: AnyBulkWriteOperation<SubscriberDoc>[] = rows.map((row) => ({
      updateOne: {
        filter: { ndid, email: row.email.toLowerCase() },
        update: {
          $setOnInsert: {
            status: "subscribed",
            source,
            subscribedAt: now,
            unsubscribedAt: null,
            unsubscribedBy: null,
            unsubscribeReason: null,
            ...(row.name ? {} : { name: null }),
          },
          // a name from the file fills in (or corrects) the one on the list
          ...(row.name ? { $set: { name: row.name, updatedAt: now } } : { $set: { updatedAt: now } }),
          ...(row.tags.length ? { $addToSet: { tags: { $each: row.tags } } } : {}),
        },
        upsert: true,
      },
    }));
    const result = await this.collection.bulkWrite(operations, { ordered: false });
    return { added: result.upsertedCount, updated: result.matchedCount };
  }

  async setStatus(
    ndid: string,
    ids: string[],
    status: SubscriberStatus,
    by: UnsubscribedBy | null,
    now: Date,
  ): Promise<number> {
    const _ids = SubscriberRepository.ids(ids);
    if (!_ids.length) return 0;
    const set =
      status === "subscribed"
        ? { status, unsubscribedAt: null, unsubscribedBy: null, unsubscribeReason: null, updatedAt: now }
        : { status, unsubscribedAt: now, unsubscribedBy: by ?? "hotel", updatedAt: now };
    // only rows that change, so an unsubscribe date is never moved
    const result = await this.collection.updateMany(
      { ndid, _id: { $in: _ids }, ...(status === "subscribed" ? { status: "unsubscribed" } : { status: { $ne: "unsubscribed" } }) },
      { $set: set },
    );
    return result.modifiedCount;
  }

  async addTags(ndid: string, ids: string[], tags: string[], now: Date): Promise<number> {
    const result = await this.collection.updateMany(
      { ndid, _id: { $in: SubscriberRepository.ids(ids) } },
      { $addToSet: { tags: { $each: tags } }, $set: { updatedAt: now } },
    );
    return result.modifiedCount;
  }

  async removeTags(ndid: string, ids: string[], tags: string[], now: Date): Promise<number> {
    const result = await this.collection.updateMany(
      { ndid, _id: { $in: SubscriberRepository.ids(ids) } },
      { $pull: { tags: { $in: tags } }, $set: { updatedAt: now } },
    );
    return result.modifiedCount;
  }

  async remove(ndid: string, ids: string[]): Promise<number> {
    const result = await this.collection.deleteMany({ ndid, _id: { $in: SubscriberRepository.ids(ids) } });
    return result.deletedCount;
  }

  async tags(ndid: string): Promise<string[]> {
    const tags = await this.collection.distinct("tags", { ndid });
    return (tags as unknown[]).filter((t): t is string => typeof t === "string").sort((a, b) => a.localeCompare(b));
  }

  async stats(ndid: string, now: Date): Promise<NewsletterStats> {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    const since30 = new Date(now.getTime() - 30 * DAY_MS);
    // old rows have no subscribedAt: their _id says when they were added
    const joined = { $ifNull: ["$subscribedAt", { $toDate: "$_id" }] };
    const isUnsubscribed = { $eq: ["$status", "unsubscribed"] };

    const [row] = await this.collection
      .aggregate<{
        totals: { total: number; unsubscribed: number; new30: number; unsub30: number }[];
        joinedByMonth: { _id: string; count: number }[];
        leftByMonth: { _id: string; count: number }[];
        bySource: { _id: SubscriberSource | null; count: number }[];
      }>([
        { $match: { ndid } },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  unsubscribed: { $sum: { $cond: [isUnsubscribed, 1, 0] } },
                  new30: {
                    $sum: { $cond: [{ $and: [{ $not: [isUnsubscribed] }, { $gte: [joined, since30] }] }, 1, 0] },
                  },
                  unsub30: {
                    $sum: { $cond: [{ $and: [isUnsubscribed, { $gte: ["$unsubscribedAt", since30] }] }, 1, 0] },
                  },
                },
              },
            ],
            joinedByMonth: [
              { $match: { source: { $ne: "campaign" } } },
              { $project: { at: joined } },
              { $match: { at: { $gte: monthStart } } },
              { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$at" } }, count: { $sum: 1 } } },
            ],
            leftByMonth: [
              { $match: { status: "unsubscribed", unsubscribedAt: { $gte: monthStart } } },
              { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$unsubscribedAt" } }, count: { $sum: 1 } } },
            ],
            bySource: [{ $group: { _id: "$source", count: { $sum: 1 } } }],
          },
        },
      ])
      .toArray();

    const totals = row?.totals[0] ?? { total: 0, unsubscribed: 0, new30: 0, unsub30: 0 };
    const joinedMap = new Map(row?.joinedByMonth.map((m) => [m._id, m.count]));
    const leftMap = new Map(row?.leftByMonth.map((m) => [m._id, m.count]));
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + i, 1));
      const month = d.toISOString().slice(0, 7);
      return { month, subscribed: joinedMap.get(month) ?? 0, unsubscribed: leftMap.get(month) ?? 0 };
    });
    const bySource: NewsletterStats["bySource"] = {};
    for (const s of row?.bySource ?? []) {
      const key = s._id ?? "website";
      bySource[key] = (bySource[key] ?? 0) + s.count;
    }

    return {
      total: totals.total,
      subscribed: totals.total - totals.unsubscribed,
      unsubscribed: totals.unsubscribed,
      newLast30Days: totals.new30,
      unsubscribedLast30Days: totals.unsub30,
      months,
      bySource,
    };
  }

  private static query(ndid: string, { status, source, tag, search }: SubscriberFilter): Filter<SubscriberDoc> {
    const and: Filter<SubscriberDoc>[] = [{ ndid }];
    // a row without status is subscribed
    if (status === "subscribed") and.push({ status: { $ne: "unsubscribed" } });
    if (status === "unsubscribed") and.push({ status: "unsubscribed" });
    // a row without source came from the website box
    if (source === "website") and.push({ $or: [{ source: "website" }, { source: { $exists: false } }] });
    else if (source) and.push({ source });
    if (tag) and.push({ tags: tag });
    if (search) {
      const pattern = { $regex: escapeRegex(search.trim()), $options: "i" };
      and.push({ $or: [{ email: pattern }, { name: pattern }] });
    }
    return and.length === 1 ? and[0]! : { $and: and };
  }

  private static ids(ids: string[]): Types.ObjectId[] {
    return ids.map((id) => ObjectIds.parse(id)).filter((id): id is Types.ObjectId => id !== null);
  }

  private static toSubscriber(doc: SubscriberDoc): Subscriber {
    const subscribedAt = doc.subscribedAt ?? doc._id.getTimestamp();
    return {
      id: String(doc._id),
      ndid: doc.ndid,
      email: doc.email,
      name: doc.name ?? null,
      status: doc.status ?? "subscribed",
      source: doc.source ?? "website",
      tags: doc.tags ?? [],
      subscribedAt,
      unsubscribedAt: doc.unsubscribedAt ?? null,
      unsubscribedBy: doc.unsubscribedBy ?? null,
      unsubscribeReason: doc.unsubscribeReason ?? null,
      updatedAt: doc.updatedAt ?? subscribedAt,
    };
  }
}
