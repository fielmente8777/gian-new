import mongoose, { Types } from "mongoose";

import {
  DEFAULT_POOL_SETTINGS,
  type Changed,
  type DailyCost,
  type PoolAlertKind,
  type PoolSettings,
  type PoolSettingsInput,
  type PoolStateStore,
  type ProviderCostStore,
  type SyncStatus,
  type TopUp,
  type TopUpInput,
  type TopUpStore,
} from "../types/ai-credits.types.js";

// gian-new's own collections for the OpenAI account. gian never reads them.
//   ai_provider_cost_daily   one row per UTC day + line item + project, from OpenAI's Costs API
//   ai_provider_topups       money staff put into the OpenAI account
//   ai_credits_state         pool settings, last alerts, last sync, the sync lock

type CostDocument = DailyCost & { _id: string; fetchedAt: Date };

/** ai_provider_cost_daily. _id = date|lineItem|projectId, so writing a day twice changes nothing. */
export class ProviderCostRepository implements ProviderCostStore {
  private get collection() {
    return mongoose.connection.collection<CostDocument>("ai_provider_cost_daily");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ date: 1 });
  }

  static key(row: DailyCost): string {
    return `${row.date}|${row.lineItem}|${row.projectId ?? "-"}`;
  }

  async latestDate(): Promise<string | null> {
    const doc = await this.collection
      .find({}, { projection: { date: 1 } })
      .sort({ date: -1 })
      .limit(1)
      .next();
    return doc?.date ?? null;
  }

  async replaceDays(days: string[], rows: DailyCost[], fetchedAt: Date): Promise<void> {
    if (days.length === 0) return;
    const keep = rows.map(ProviderCostRepository.key);
    // lines OpenAI no longer reports for these days go; the rest are written again
    await this.collection.deleteMany({ date: { $in: days }, _id: { $nin: keep } });
    if (rows.length === 0) return;
    await this.collection.bulkWrite(
      rows.map((row) => ({
        replaceOne: {
          filter: { _id: ProviderCostRepository.key(row) },
          replacement: { ...row, fetchedAt },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  async dailyTotals(from: string, to: string): Promise<{ date: string; amountUsd: number }[]> {
    return this.collection
      .aggregate<{ date: string; amountUsd: number }>([
        { $match: { date: { $gte: from, $lte: to } } },
        { $group: { _id: "$date", amountUsd: { $sum: "$amountUsd" } } },
        { $project: { _id: 0, date: "$_id", amountUsd: 1 } },
        { $sort: { date: 1 } },
      ])
      .toArray();
  }

  async lineItems(from: string, to: string): Promise<{ lineItem: string; amountUsd: number }[]> {
    return this.collection
      .aggregate<{ lineItem: string; amountUsd: number }>([
        { $match: { date: { $gte: from, $lte: to } } },
        { $group: { _id: "$lineItem", amountUsd: { $sum: "$amountUsd" } } },
        { $project: { _id: 0, lineItem: "$_id", amountUsd: 1 } },
        { $sort: { amountUsd: -1 } },
      ])
      .toArray();
  }

  async sumSince(from: string): Promise<number> {
    const [row] = await this.collection
      .aggregate<{ total: number }>([
        { $match: { date: { $gte: from } } },
        { $group: { _id: null, total: { $sum: "$amountUsd" } } },
      ])
      .toArray();
    return row?.total ?? 0;
  }
}

type TopUpDocument = Omit<TopUp, "id"> & { _id: Types.ObjectId };

/** ai_provider_topups. Never deleted: a wrong entry is corrected, and the change is logged. */
export class TopUpRepository implements TopUpStore {
  private get collection() {
    return mongoose.connection.collection<TopUpDocument>("ai_provider_topups");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ paidOn: -1 });
  }

  async list(): Promise<TopUp[]> {
    const docs = await this.collection.find().sort({ paidOn: -1, _id: -1 }).toArray();
    return docs.map(TopUpRepository.view);
  }

  async create(input: TopUpInput, by: string, now: Date): Promise<TopUp> {
    const doc: TopUpDocument = {
      _id: new Types.ObjectId(),
      ...input,
      createdBy: by,
      createdAt: now,
      updatedBy: null,
      updatedAt: null,
    };
    await this.collection.insertOne(doc);
    return TopUpRepository.view(doc);
  }

  async update(id: string, changes: Partial<TopUpInput>, by: string, now: Date): Promise<Changed<TopUp> | null> {
    if (!/^[a-f\d]{24}$/i.test(id)) return null;
    const before = await this.collection.findOneAndUpdate(
      { _id: new Types.ObjectId(id) },
      { $set: { ...changes, updatedBy: by, updatedAt: now } },
      { returnDocument: "before" },
    );
    if (!before) return null;
    const after = { ...before, ...changes, updatedBy: by, updatedAt: now };
    return { before: TopUpRepository.view(before), after: TopUpRepository.view(after) };
  }

  private static view({ _id, ...rest }: TopUpDocument): TopUp {
    return { id: _id.toHexString(), ...rest };
  }
}

interface StateDocument {
  _id: string;
  [field: string]: unknown;
}

const SETTINGS_ID = "pool-settings";
const ALERTS_ID = "pool-alerts";
const SYNC_ID = "cost-sync";

/** ai_credits_state: a few named documents. Missing ones fall back to the defaults. */
export class PoolStateRepository implements PoolStateStore {
  private get collection() {
    return mongoose.connection.collection<StateDocument>("ai_credits_state");
  }

  async getSettings(): Promise<PoolSettings> {
    const doc = await this.collection.findOne({ _id: SETTINGS_ID });
    if (!doc) return { ...DEFAULT_POOL_SETTINGS };
    const { _id, ...saved } = doc;
    return { ...DEFAULT_POOL_SETTINGS, ...(saved as Partial<PoolSettings>) };
  }

  async saveSettings(input: PoolSettingsInput, by: string, now: Date): Promise<Changed<PoolSettings>> {
    const before = await this.getSettings();
    const rateChanged = input.usdInrRate !== undefined && input.usdInrRate !== before.usdInrRate;
    await this.collection.updateOne(
      { _id: SETTINGS_ID },
      { $set: { ...input, updatedBy: by, ...(rateChanged ? { usdInrRateUpdatedAt: now } : {}) } },
      { upsert: true },
    );
    return { before, after: await this.getSettings() };
  }

  async lastAlert(kind: PoolAlertKind): Promise<Date | null> {
    const doc = await this.collection.findOne({ _id: ALERTS_ID });
    const at = doc?.[kind];
    return at instanceof Date ? at : null;
  }

  async markAlert(kind: PoolAlertKind, at: Date): Promise<void> {
    await this.collection.updateOne({ _id: ALERTS_ID }, { $set: { [kind]: at } }, { upsert: true });
  }

  async lastSync(): Promise<SyncStatus | null> {
    const doc = await this.collection.findOne({ _id: SYNC_ID });
    if (!doc) return null;
    const { _id, ...status } = doc;
    return status as unknown as SyncStatus;
  }

  async saveSync(status: SyncStatus): Promise<void> {
    await this.collection.replaceOne({ _id: SYNC_ID }, { ...status }, { upsert: true });
  }

  async acquireLock(name: string, owner: string, until: Date, now: Date): Promise<boolean> {
    try {
      // matches a free or expired lock; when it's held the upsert inserts a duplicate _id and fails
      await this.collection.updateOne(
        { _id: `lock:${name}`, $or: [{ until: { $lt: now } }, { until: { $exists: false } }] },
        { $set: { owner, until } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  }

  async releaseLock(name: string, owner: string): Promise<void> {
    await this.collection.updateOne({ _id: `lock:${name}`, owner }, { $set: { until: new Date(0) } });
  }
}
