import mongoose, { Types } from "mongoose";

import type {
  ActivatePeriod,
  AutoRenewal,
  BillingPeriod,
  StaffStop,
  SubscriptionBillingPort,
  SubscriptionBillingSnapshot,
  SubscriptionBillingStats,
  SubscriptionStatus,
} from "../types/subscriptions.types.js";

interface Doc {
  _id: Types.ObjectId;
  ndid: string;
  planId?: Types.ObjectId | null;
  status?: SubscriptionStatus;
  startDate?: Date;
  endDate?: Date;
  staffStop?: StaffStop | null;
  lastPaymentId?: string | null;
  apps?: { appId?: Types.ObjectId; isTrial?: boolean; startDate?: Date; endDate?: Date }[];
  appAccess?: Record<string, unknown>;
  autoRenew?: boolean;
  billing?: (Omit<BillingPeriod, "planId"> & { planId: Types.ObjectId | string }) | null;
  autoRenewal?: AutoRenewal | null;
}

const DAY_MS = 86_400_000;

/**
 * The billing side of gian's `subscriptions` documents. Like SubscriptionRepository it $sets
 * named fields only, keeps gian's status values, and writes apps in gian's shape (`appId`
 * populated by the hotel dashboard, `_id` per entry), so gian and nexon keep reading it.
 * New fields: `billing` (the paid period) and `autoRenewal` (the Razorpay mandate).
 */
export class SubscriptionBillingRepository implements SubscriptionBillingPort {
  private get subscriptions() {
    return mongoose.connection.collection<Doc>("subscriptions");
  }

  async snapshot(ndid: string): Promise<SubscriptionBillingSnapshot | null> {
    const doc = await this.subscriptions.findOne({ ndid });
    if (!doc) return null;
    return {
      ndid: doc.ndid,
      planId: doc.planId ? String(doc.planId) : null,
      status: doc.status ?? "ACTIVE",
      startDate: doc.startDate ?? new Date(0),
      endDate: doc.endDate ?? new Date(0),
      staffStop: doc.staffStop ?? null,
      lastPaymentId: doc.lastPaymentId ?? null,
      apps: (doc.apps ?? [])
        .filter((a) => a.appId)
        .map((a) => ({
          appId: String(a.appId),
          isTrial: a.isTrial === true,
          startDate: a.startDate ?? new Date(0),
          endDate: a.endDate ?? new Date(0),
        })),
      appAccess: Object.fromEntries(Object.entries(doc.appAccess ?? {}).map(([k, v]) => [k, v === true])),
      autoRenew: doc.autoRenew === true,
      billing: doc.billing ? { ...doc.billing, planId: String(doc.billing.planId) } : null,
      autoRenewal: doc.autoRenewal ?? null,
    };
  }

  async activate(ndid: string, period: ActivatePeriod, now: Date): Promise<void> {
    const access = Object.fromEntries(Object.entries(period.appAccess).map(([k, v]) => [`appAccess.${k}`, v]));
    await this.subscriptions.updateOne(
      { ndid },
      {
        $set: {
          planId: new Types.ObjectId(period.planId),
          startDate: period.startDate,
          endDate: period.endDate,
          status: "ACTIVE",
          staffStop: null,
          cancelledAt: null,
          apps: period.apps.map((a) => ({
            _id: new Types.ObjectId(),
            appId: new Types.ObjectId(a.appId),
            isTrial: false,
            startDate: a.startDate,
            endDate: a.endDate,
          })),
          ...access,
          billing: { ...period.billing, planId: new Types.ObjectId(period.billing.planId) },
          ...(period.orderId ? { currentOrderId: period.orderId } : {}),
          ...(period.paymentId ? { lastPaymentId: period.paymentId } : {}),
          updatedAt: now,
        } as Partial<Doc>,
        $setOnInsert: { ndid, autoRenew: false, createdAt: now } as Partial<Doc>,
      },
      { upsert: true },
    );
  }

  async setAutoRenewal(ndid: string, autoRenewal: AutoRenewal | null, autoRenew: boolean, now: Date): Promise<void> {
    await this.subscriptions.updateOne({ ndid }, { $set: { autoRenewal, autoRenew, updatedAt: now } as Partial<Doc> });
  }

  async findNdidByAutoRenewal(gatewaySubscriptionId: string): Promise<string | null> {
    const doc = await this.subscriptions.findOne(
      { "autoRenewal.gatewaySubscriptionId": gatewaySubscriptionId },
      { projection: { ndid: 1 } },
    );
    return doc?.ndid ?? null;
  }

  /** One aggregation: every subscription classified once, then counted. */
  async stats(now: Date): Promise<SubscriptionBillingStats> {
    const soon = new Date(now.getTime() + 30 * DAY_MS);
    const [result] = await this.subscriptions
      .aggregate<{
        phases: { _id: string; n: number }[];
        due: { n: number }[];
        auto: { n: number }[];
        byPlan: { _id: string | null; n: number }[];
        mrr: { paise: number }[];
      }>([
        {
          $addFields: {
            trialOnly: {
              $and: [
                { $eq: [{ $ifNull: ["$billing", null] }, null] },
                { $eq: [{ $ifNull: ["$lastPaymentId", null] }, null] },
                { $allElementsTrue: [{ $map: { input: { $ifNull: ["$apps", []] }, in: "$$this.isTrial" } }] },
              ],
            },
          },
        },
        {
          $addFields: {
            phase: {
              $switch: {
                branches: [
                  { case: { $eq: [{ $type: "$staffStop" }, "object"] }, then: "stopped" },
                  { case: { $or: [{ $lte: ["$endDate", now] }, { $eq: ["$status", "CANCELLED"] }] }, then: "ended" },
                  { case: "$trialOnly", then: "trial" },
                ],
                default: "paying",
              },
            },
          },
        },
        {
          $facet: {
            phases: [{ $group: { _id: "$phase", n: { $sum: 1 } } }],
            due: [{ $match: { phase: "paying", endDate: { $lte: soon } } }, { $count: "n" }],
            auto: [{ $match: { autoRenew: true, phase: "paying" } }, { $count: "n" }],
            byPlan: [
              { $match: { phase: "paying" } },
              { $lookup: { from: "plans", localField: "planId", foreignField: "_id", as: "plan" } },
              { $group: { _id: { $first: "$plan.planName" }, n: { $sum: 1 } } },
            ],
            mrr: [
              { $match: { phase: "paying", "billing.netPaise": { $gt: 0 } } },
              {
                $group: {
                  _id: null,
                  paise: { $sum: { $divide: ["$billing.netPaise", { $max: ["$billing.cycleMonths", 1] }] } },
                },
              },
            ],
          },
        },
      ])
      .toArray();
    const phase = (name: string) => result?.phases.find((p) => p._id === name)?.n ?? 0;
    return {
      total: (result?.phases ?? []).reduce((sum, p) => sum + p.n, 0),
      paying: phase("paying"),
      trial: phase("trial"),
      ended: phase("ended"),
      stopped: phase("stopped"),
      renewalsDue30d: result?.due[0]?.n ?? 0,
      autoRenewOn: result?.auto[0]?.n ?? 0,
      byPlan: (result?.byPlan ?? [])
        .map((p) => ({ planCode: p._id ?? "—", count: p.n }))
        .sort((a, b) => b.count - a.count),
      mrrPaise: Math.round(result?.mrr[0]?.paise ?? 0),
    };
  }
}
