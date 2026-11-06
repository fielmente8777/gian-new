import mongoose, { Types } from "mongoose";

import type { PurchaseTerms } from "../../subscriptions/index.js";
import type {
  NewPayment,
  PaymentKind,
  PaymentListItem,
  PaymentPage,
  PaymentQuery,
  PaymentRecord,
  PaymentStatus,
  PaymentStore,
  Quote,
  RevenueSummary,
} from "../types/billing.types.js";

interface PaymentDoc {
  _id: Types.ObjectId;
  ndid: string;
  orderId: string;
  paymentId?: string | null;
  planId?: Types.ObjectId | null;
  amount?: number;
  currency?: string;
  status?: string;
  method?: string | null;
  paidAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  apps?: unknown[];
  source?: string;
  kind?: PaymentKind;
  terms?: (Omit<PurchaseTerms, "planId"> & { planId: string }) | null;
  quote?: Quote | null;
  offerCode?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  claimedAt?: Date | null;
  appliedAt?: Date | null;
  autoRenewRequested?: boolean;
  failureReason?: string | null;
  createdBy?: string | null;
  hotelName?: string | null;
  planCode?: string | null;
}

const IST_OFFSET_MS = 330 * 60_000;
const CLAIM_LEASE_MS = 2 * 60_000;
const paidStatus = "SUCCESS";

/**
 * gian's `payments` collection. gian's old checkout writes here too (status "created" then
 * "SUCCESS", amount in paise), so one list shows every payment ever made. Ours carry
 * `source: "gian-new"`.
 */
export class PaymentRepository implements PaymentStore {
  private get collection() {
    return mongoose.connection.collection<PaymentDoc>("payments");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ ndid: 1, createdAt: -1 });
    await this.collection.createIndex({ status: 1, paidAt: -1 });
  }

  async create(p: NewPayment): Promise<PaymentRecord> {
    const _id = new Types.ObjectId();
    await this.collection.insertOne(PaymentRepository.toDoc(_id, p));
    return (await this.findByOrderId(p.orderId))!;
  }

  async findByOrderId(orderId: string): Promise<PaymentRecord | null> {
    const doc = await this.collection.findOne({ orderId });
    return doc ? PaymentRepository.toRecord(doc) : null;
  }

  async claim(
    orderId: string,
    paid: { paymentId: string; method: string | null; paidAt: Date },
    now: Date,
  ): Promise<PaymentRecord | null> {
    const doc = await this.collection.findOneAndUpdate(
      {
        orderId,
        source: "gian-new",
        appliedAt: null,
        $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now.getTime() - CLAIM_LEASE_MS) } }],
      },
      {
        $set: {
          status: paidStatus,
          paymentId: paid.paymentId,
          method: paid.method,
          paidAt: paid.paidAt,
          claimedAt: now,
          failureReason: null,
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    );
    return doc ? PaymentRepository.toRecord(doc) : null;
  }

  async markApplied(orderId: string, now: Date): Promise<void> {
    await this.collection.updateOne({ orderId }, { $set: { appliedAt: now, updatedAt: now } });
  }

  async markFailed(orderId: string, reason: string, paymentId: string | null): Promise<void> {
    // a later successful attempt on the same order wins
    await this.collection.updateOne(
      { orderId, status: { $ne: paidStatus } },
      { $set: { status: "FAILED", failureReason: reason, ...(paymentId ? { paymentId } : {}), updatedAt: new Date() } },
    );
  }

  async insertApplied(p: NewPayment, now: Date): Promise<boolean> {
    if (await this.collection.findOne({ orderId: p.orderId }, { projection: { _id: 1 } })) return false;
    try {
      await this.collection.insertOne({ ...PaymentRepository.toDoc(new Types.ObjectId(), p), claimedAt: now, appliedAt: now });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }

  async list({ page, pageSize, status, ndid, ndids, from, to, source }: PaymentQuery): Promise<PaymentPage> {
    const match: Record<string, unknown> = {};
    if (ndids) match.ndid = { $in: ndids };
    if (status) match.status = status === "created" ? { $in: ["created", "CREATED"] } : status;
    if (ndid) match.ndid = ndid;
    if (source === "gian-new") match.source = "gian-new";
    if (source === "gian") match.source = { $exists: false };
    if (from || to) match.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };

    const [result] = await this.collection
      .aggregate<{ items: PaymentDoc[]; total: { n: number }[] }>([
        { $match: match },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            total: [{ $count: "n" }],
            items: [
              { $skip: (page - 1) * pageSize },
              { $limit: pageSize },
              {
                $lookup: {
                  from: "Zucks_profile",
                  localField: "ndid",
                  foreignField: "ndid",
                  as: "profile",
                  pipeline: [{ $project: { _id: 0, hotelName: 1 } }],
                },
              },
              {
                $lookup: {
                  from: "plans",
                  localField: "planId",
                  foreignField: "_id",
                  as: "plan",
                  pipeline: [{ $project: { _id: 0, planName: 1 } }],
                },
              },
              {
                $addFields: {
                  hotelName: { $first: "$profile.hotelName" },
                  planCode: { $first: "$plan.planName" },
                },
              },
              { $project: { profile: 0, plan: 0, quote: 0 } },
            ],
          },
        },
      ])
      .toArray();
    return {
      items: (result?.items ?? []).map(
        (doc): PaymentListItem => ({
          ...PaymentRepository.toRecord(doc),
          hotelName: doc.hotelName ?? null,
          planCode: doc.planCode ?? doc.terms?.planCode ?? null,
        }),
      ),
      total: result?.total[0]?.n ?? 0,
    };
  }

  async offerUses(ndid: string, offerCode: string): Promise<number> {
    return this.collection.countDocuments({ ndid, offerCode: offerCode.toUpperCase(), status: paidStatus });
  }

  async hasPaid(ndid: string): Promise<boolean> {
    return (await this.collection.countDocuments({ ndid, status: paidStatus }, { limit: 1 })) > 0;
  }

  async lastSuccessful(ndid: string): Promise<PaymentRecord | null> {
    const [doc] = await this.collection.find({ ndid, status: paidStatus }).sort({ paidAt: -1, createdAt: -1 }).limit(1).toArray();
    return doc ? PaymentRepository.toRecord(doc) : null;
  }

  async revenue(now: Date): Promise<RevenueSummary> {
    const monthStart = PaymentRepository.istMonthStart(now, 0);
    const lastMonthStart = PaymentRepository.istMonthStart(now, -1);
    const yearStart = PaymentRepository.istMonthStart(now, -11);
    const day30 = new Date(now.getTime() - 30 * 86_400_000);
    const day365 = new Date(now.getTime() - 365 * 86_400_000);
    const when = { $ifNull: ["$paidAt", "$createdAt"] };
    const sumWhere = (from: Date, to?: Date) => [
      { $match: { at: { $gte: from, ...(to ? { $lt: to } : {}) } } },
      { $group: { _id: null, paise: { $sum: "$amount" }, n: { $sum: 1 } } },
    ];

    const [r] = await this.collection
      .aggregate<{
        thisMonth: { paise: number; n: number }[];
        lastMonth: { paise: number; n: number }[];
        last30: { paise: number }[];
        all: { paise: number }[];
        hotels: { n: number }[];
        byMonth: { _id: string; paise: number; n: number }[];
      }>([
        { $match: { status: paidStatus } },
        { $addFields: { at: when, amount: { $ifNull: ["$amount", 0] } } },
        {
          $facet: {
            thisMonth: sumWhere(monthStart),
            lastMonth: sumWhere(lastMonthStart, monthStart),
            last30: sumWhere(day30),
            all: [{ $group: { _id: null, paise: { $sum: "$amount" } } }],
            hotels: [{ $match: { at: { $gte: day365 } } }, { $group: { _id: "$ndid" } }, { $count: "n" }],
            byMonth: [
              { $match: { at: { $gte: yearStart } } },
              {
                $group: {
                  _id: { $dateToString: { date: "$at", format: "%Y-%m", timezone: "Asia/Kolkata" } },
                  paise: { $sum: "$amount" },
                  n: { $sum: 1 },
                },
              },
            ],
          },
        },
      ])
      .toArray();

    const months = Array.from({ length: 12 }, (_, i) => {
      const start = PaymentRepository.istMonthStart(now, i - 11);
      const key = new Date(start.getTime() + IST_OFFSET_MS).toISOString().slice(0, 7);
      const found = r?.byMonth.find((m) => m._id === key);
      return { month: key, paise: found?.paise ?? 0, count: found?.n ?? 0 };
    });
    return {
      thisMonthPaise: r?.thisMonth[0]?.paise ?? 0,
      lastMonthPaise: r?.lastMonth[0]?.paise ?? 0,
      last30DaysPaise: r?.last30[0]?.paise ?? 0,
      allTimePaise: r?.all[0]?.paise ?? 0,
      paymentsThisMonth: r?.thisMonth[0]?.n ?? 0,
      payingHotels12m: r?.hotels[0]?.n ?? 0,
      byMonth: months,
    };
  }

  /** The start of the India-time month `offset` months from now's month, as a UTC instant. */
  static istMonthStart(now: Date, offset: number): Date {
    const ist = new Date(now.getTime() + IST_OFFSET_MS);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + offset, 1) - IST_OFFSET_MS);
  }

  private static toDoc(_id: Types.ObjectId, p: NewPayment): PaymentDoc {
    return {
      _id,
      ndid: p.ndid,
      orderId: p.orderId,
      paymentId: p.paymentId,
      planId: p.planId ? new Types.ObjectId(p.planId) : null,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      method: p.method,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
      // gian's shape, so its Subscription page lists the apps too
      apps: (p.quote?.addonCodes ?? []).map((code) => ({ code })),
      source: p.source ?? "gian-new",
      kind: p.kind ?? undefined,
      terms: p.terms,
      quote: p.quote,
      offerCode: p.offerCode,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      claimedAt: null,
      appliedAt: null,
      autoRenewRequested: p.autoRenewRequested,
      failureReason: null,
      createdBy: p.createdBy,
    };
  }

  private static toRecord(d: PaymentDoc): PaymentRecord {
    const status = String(d.status ?? "created");
    return {
      id: String(d._id),
      ndid: d.ndid,
      orderId: d.orderId,
      paymentId: d.paymentId ?? null,
      planId: d.planId ? String(d.planId) : null,
      amount: Number(d.amount ?? 0),
      currency: (d.currency ?? "INR").toUpperCase(),
      status: (status === "SUCCESS" || status === "FAILED" ? status : "created") as PaymentStatus,
      method: d.method ?? null,
      paidAt: d.paidAt ?? null,
      createdAt: d.createdAt ?? d._id.getTimestamp(),
      source: d.source ?? null,
      kind: d.kind ?? null,
      terms: d.terms ?? null,
      quote: d.quote ?? null,
      offerCode: d.offerCode ?? null,
      periodStart: d.periodStart ?? null,
      periodEnd: d.periodEnd ?? null,
      appliedAt: d.appliedAt ?? null,
      autoRenewRequested: d.autoRenewRequested === true,
      failureReason: d.failureReason ?? null,
      createdBy: d.createdBy ?? null,
    };
  }
}
