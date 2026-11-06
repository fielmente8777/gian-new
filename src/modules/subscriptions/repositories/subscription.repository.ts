import mongoose, { Types, type Document as MongoDoc } from "mongoose";

import { ObjectIds } from "../../../shared/database/object-id.js";
import {
  ENDING_SOON_DAYS,
  type AppAssignment,
  type AppRecord,
  type SubscriptionApp,
  type PlanRecord,
  type StaffStop,
  type SubscriptionPage,
  type SubscriptionRecord,
  type SubscriptionSearch,
  type SubscriptionsPort,
  type SubscriptionStatus,
} from "../types/subscriptions.types.js";

interface SubscriptionDocument {
  _id: Types.ObjectId;
  ndid: string;
  planId?: Types.ObjectId | null;
  status?: SubscriptionStatus;
  startDate?: Date;
  endDate?: Date;
  autoRenew?: boolean;
  staffStop?: StaffStop | null;
  apps?: { _id?: Types.ObjectId; appId?: Types.ObjectId; isTrial?: boolean; startDate?: Date; endDate?: Date }[];
  appAccess?: Record<string, unknown>;
  updatedAt?: Date;
  /** from the $lookups */
  appCatalogue?: { _id: Types.ObjectId; name?: string; code?: string }[];
  plan?: { _id: Types.ObjectId; planName?: string; price?: number }[];
  profile?: { hotelName?: string | null }[];
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DAY_MS = 86_400_000;

/**
 * gian's `subscriptions` and `plans` collections. gian (payments, trials) and nexon (the
 * hotel's getuser) read and write the same documents, so writes $set named fields only and
 * the status stays within gian's enum (ACTIVE, EXPIRED, CANCELLED, TRIAL). Staff stops live in
 * a field gian does not know, `staffStop`.
 */
export class SubscriptionRepository implements SubscriptionsPort {
  private get subscriptions() {
    return mongoose.connection.collection<SubscriptionDocument>("subscriptions");
  }

  async appCatalogue(): Promise<AppRecord[]> {
    const docs = await mongoose.connection.collection("apps").find({}).sort({ name: 1 }).toArray();
    return docs.map((doc) => ({
      id: String(doc._id),
      name: String(doc.name ?? ""),
      code: String(doc.code ?? ""),
      price: Number(doc.price ?? 0),
      isActive: doc.isActive !== false,
    }));
  }

  async setApps(ndid: string, apps: AppAssignment[], now: Date): Promise<SubscriptionRecord | null> {
    const current = await this.subscriptions.findOne({ ndid }, { projection: { apps: 1 } });
    if (!current) return null;
    const catalogue = await this.appCatalogue();
    const firstStart = new Map<string, Date>();
    for (const entry of current.apps ?? []) {
      const id = String(entry.appId);
      const start = entry.startDate ?? now;
      if (!firstStart.has(id) || start < firstStart.get(id)!) firstStart.set(id, start);
    }
    const chosen = new Set(apps.map((a) => a.appId));
    // gian's shape: the hotel dashboard populates appId and keys its list by _id
    const entries = apps.map((a) => ({
      _id: new Types.ObjectId(),
      appId: new Types.ObjectId(a.appId),
      isTrial: a.isTrial,
      startDate: firstStart.get(a.appId) ?? now,
      endDate: a.endDate,
    }));
    const access = Object.fromEntries(
      catalogue.filter((c) => c.code).map((c) => [`appAccess.${c.code}`, chosen.has(c.id)]),
    );
    await this.subscriptions.updateOne({ ndid }, { $set: { apps: entries, ...access, updatedAt: now } });
    return this.findByNdid(ndid);
  }

  async plans(): Promise<PlanRecord[]> {
    const docs = await mongoose.connection.collection("plans").find({}).sort({ price: 1 }).toArray();
    return docs.map((doc) => ({
      id: String(doc._id),
      name: String(doc.planName ?? ""),
      price: Number(doc.price ?? 0),
    }));
  }

  /**
   * One round trip: the profile's hotel name and the plan are joined, the state is computed in
   * the database, and a $facet returns the counts per state, the total and the requested page.
   */
  async list({ page, pageSize, sort, order, state, ndids, search }: SubscriptionSearch): Promise<SubscriptionPage> {
    const now = new Date();
    const endingBy = new Date(now.getTime() + ENDING_SOON_DAYS * DAY_MS);
    const direction = order === "desc" ? -1 : 1;
    const sortKey = { hotel: "hotelSort", plan: "planPrice", endDate: "endDate", state: "stateRank" }[sort];

    const [result] = await this.subscriptions
      .aggregate<{
        items: SubscriptionDocument[];
        total: { n: number }[];
        counts: { _id: string; n: number }[];
      }>([
        ...(ndids ? [{ $match: { ndid: { $in: ndids } } }] : []),
        {
          $lookup: {
            from: "Zucks_profile",
            localField: "ndid",
            foreignField: "ndid",
            as: "profile",
            pipeline: [{ $project: { _id: 0, hotelName: 1 } }],
          },
        },
        { $addFields: { hotelName: { $first: "$profile.hotelName" } } },
        ...(search
          ? [{ $match: { $or: [{ ndid: search }, { hotelName: new RegExp(escapeRegex(search), "i") }] } }]
          : []),
        { $lookup: { from: "plans", localField: "planId", foreignField: "_id", as: "plan" } },
        {
          $lookup: {
            from: "apps",
            localField: "apps.appId",
            foreignField: "_id",
            as: "appCatalogue",
            pipeline: [{ $project: { name: 1, code: 1 } }],
          },
        },
        {
          $addFields: {
            state: {
              $switch: {
                branches: [
                  { case: { $eq: [{ $type: "$staffStop" }, "object"] }, then: "stopped" },
                  { case: { $or: [{ $lte: ["$endDate", now] }, { $eq: ["$status", "CANCELLED"] }] }, then: "ended" },
                  { case: { $lte: ["$endDate", endingBy] }, then: "ending" },
                ],
                default: "active",
              },
            },
            hotelSort: { $toLower: { $ifNull: ["$hotelName", "$ndid"] } },
            planPrice: { $ifNull: [{ $first: "$plan.price" }, -1] },
          },
        },
        { $addFields: { stateRank: { $indexOfArray: [["active", "ending", "ended", "stopped"], "$state"] } } },
        {
          $facet: {
            counts: [{ $group: { _id: "$state", n: { $sum: 1 } } }],
            total: [...(state ? [{ $match: { state } }] : []), { $count: "n" }],
            items: [
              ...(state ? [{ $match: { state } }] : []),
              { $sort: { [sortKey]: direction, ndid: 1 } },
              { $skip: (page - 1) * pageSize },
              { $limit: pageSize },
            ],
          },
        },
      ])
      .toArray();

    const counts = { all: 0, active: 0, ending: 0, ended: 0, stopped: 0 };
    for (const { _id, n } of result?.counts ?? []) {
      counts[_id as keyof typeof counts] = n;
      counts.all += n;
    }
    return {
      items: (result?.items ?? []).map((doc) => ({
        ...this.toRecord(doc),
        state: (doc as unknown as { state: SubscriptionPage["items"][number]["state"] }).state,
      })),
      total: result?.total[0]?.n ?? 0,
      counts,
    };
  }

  async findByNdid(ndid: string): Promise<SubscriptionRecord | null> {
    const [doc] = await this.subscriptions
      .aggregate<SubscriptionDocument>([
        { $match: { ndid } },
        { $limit: 1 },
        {
          $lookup: {
            from: "Zucks_profile",
            localField: "ndid",
            foreignField: "ndid",
            as: "profile",
            pipeline: [{ $project: { hotelName: 1 } }],
          },
        },
        { $lookup: { from: "plans", localField: "planId", foreignField: "_id", as: "plan" } },
        {
          $lookup: {
            from: "apps",
            localField: "apps.appId",
            foreignField: "_id",
            as: "appCatalogue",
            pipeline: [{ $project: { name: 1, code: 1 } }],
          },
        },
      ])
      .toArray();
    return doc ? this.toRecord(doc) : null;
  }

  async pause(
    ndid: string,
    by: string,
    reason: string | null,
    now: Date,
    appsEnded = false,
  ): Promise<SubscriptionRecord | null> {
    const current = await this.subscriptions.findOne({ ndid });
    if (!current) return null;
    if (current.staffStop) return this.findByNdid(ndid);
    const remainingMs = Math.max(0, (current.endDate?.getTime() ?? now.getTime()) - now.getTime());
    const staffStop: StaffStop = { kind: "paused", at: now, by, reason, remainingMs, appsEnded };
    return this.set(ndid, { staffStop, endDate: now, updatedAt: now });
  }

  async resume(ndid: string, now: Date): Promise<SubscriptionRecord | null> {
    const current = await this.subscriptions.findOne({ ndid });
    if (!current) return null;
    if (current.staffStop?.kind !== "paused") return this.findByNdid(ndid);
    const endDate = new Date(now.getTime() + (current.staffStop.remainingMs ?? 0));
    return this.set(ndid, { endDate, staffStop: null, updatedAt: now });
  }

  async renew(ndid: string, until: Date, planId: string | null, now: Date): Promise<SubscriptionRecord | null> {
    return this.set(ndid, {
      endDate: until,
      status: "ACTIVE",
      staffStop: null,
      updatedAt: now,
      ...(planId ? { planId: new Types.ObjectId(planId) } : {}),
    });
  }

  async expire(
    ndid: string,
    by: string,
    reason: string | null,
    now: Date,
    appsEnded = false,
  ): Promise<SubscriptionRecord | null> {
    const staffStop: StaffStop = { kind: "expired", at: now, by, reason, remainingMs: null, appsEnded };
    return this.set(ndid, { endDate: now, status: "EXPIRED", staffStop, updatedAt: now });
  }

  async changePlan(ndid: string, planId: string, now: Date): Promise<SubscriptionRecord | null> {
    return this.set(ndid, { planId: new Types.ObjectId(planId), updatedAt: now });
  }

  async stoppedNdids(followExpiry: boolean, now: Date): Promise<string[]> {
    const stopped = { staffStop: { $type: "object" as const } };
    const filter = followExpiry
      ? { $or: [stopped, { endDate: { $lte: now } }, { status: "CANCELLED" as const }] }
      : stopped;
    return (await this.subscriptions.distinct("ndid", filter)) as string[];
  }

  /** A plan id that exists, or null. */
  async planExists(planId: string): Promise<boolean> {
    const _id = ObjectIds.parse(planId);
    return _id ? (await mongoose.connection.collection("plans").countDocuments({ _id })) > 0 : false;
  }

  private async set(ndid: string, fields: Partial<SubscriptionDocument>): Promise<SubscriptionRecord | null> {
    const result = await this.subscriptions.updateOne({ ndid }, { $set: fields });
    return result.matchedCount ? this.findByNdid(ndid) : null;
  }

  private toRecord(doc: SubscriptionDocument | MongoDoc): SubscriptionRecord {
    const d = doc as SubscriptionDocument;
    const plan = d.plan?.[0];
    return {
      ndid: d.ndid,
      hotelName: (d as { hotelName?: string | null }).hotelName ?? d.profile?.[0]?.hotelName ?? null,
      plan: plan ? { id: String(plan._id), name: String(plan.planName ?? ""), price: Number(plan.price ?? 0) } : null,
      status: d.status ?? "ACTIVE",
      startDate: d.startDate ?? new Date(0),
      endDate: d.endDate ?? new Date(0),
      autoRenew: d.autoRenew === true,
      staffStop: d.staffStop ?? null,
      apps: SubscriptionRepository.mergeApps(d),
      appAccess: Object.fromEntries(Object.entries(d.appAccess ?? {}).map(([k, v]) => [k, v === true])),
      updatedAt: d.updatedAt ?? null,
    };
  }

  /** One entry per app: payments in gian push a new entry each time, so old ones pile up. */
  private static mergeApps(d: SubscriptionDocument): SubscriptionApp[] {
    const names = new Map((d.appCatalogue ?? []).map((a) => [String(a._id), a]));
    const merged = new Map<string, SubscriptionApp>();
    for (const entry of d.apps ?? []) {
      if (!entry.appId) continue;
      const id = String(entry.appId);
      const startDate = entry.startDate ?? new Date(0);
      const endDate = entry.endDate ?? new Date(0);
      const seen = merged.get(id);
      if (!seen) {
        const info = names.get(id);
        merged.set(id, {
          appId: id,
          name: info?.name ?? null,
          code: info?.code ?? null,
          isTrial: entry.isTrial === true,
          startDate,
          endDate,
        });
      } else {
        if (startDate < seen.startDate) seen.startDate = startDate;
        if (endDate > seen.endDate) Object.assign(seen, { endDate, isTrial: entry.isTrial === true });
      }
    }
    return [...merged.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }
}
