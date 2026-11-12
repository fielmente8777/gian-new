import mongoose, { Types, type ClientSession } from "mongoose";

import { InsufficientCreditsError, IdempotencyKeyReusedError } from "../errors/ai-credits.errors.js";
import {
  AiAdminAuditLog,
  AiCreditTransaction,
  AiUsageLog,
  AiWallet,
  type IAiCreditTransaction,
  type IAiWallet,
} from "../models/gian-ai-credits.models.js";
import type {
  Actor,
  Adjustment,
  AdjustmentResult,
  LedgerPage,
  UsageRow,
  UsageSummary,
  WalletStatus,
  WalletStore,
  WalletTotals,
  WalletView,
} from "../types/ai-credits.types.js";

const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;

/** Runs `fn` in a MongoDB transaction; withTransaction retries it on write conflicts. */
export const inTransaction = async <T>(fn: (session: ClientSession) => Promise<T>): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    let out: T | undefined;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out as T;
  } finally {
    await session.endSession();
  }
};

/**
 * Client wallets and the credit ledger, in gian's collections. Staff changes follow gian's
 * adjustCredits (gian/src/services/aiCredits/admin.service.ts) exactly, so a change made here
 * and one made from the hotel dashboard's owner page look the same in every collection:
 *   - one transaction: the wallet $inc, one aicredittransactions row, one aiadminauditlogs row
 *   - a deduction only matches when balance - reservedCredits covers it, so two staff (or staff
 *     and a running AI request) can never take the wallet below what is really there
 *   - the ledger idempotencyKey is `adjustment:<key>` and unique, so a retried click is a no-op
 */
export class WalletLedgerRepository implements WalletStore {
  async find(ndid: string): Promise<WalletView> {
    const wallet = await AiWallet.findOne({ tenantId: ndid }).lean();
    return WalletLedgerRepository.view(ndid, wallet);
  }

  async findMany(ndids: string[]): Promise<Map<string, WalletView>> {
    const wallets = ndids.length ? await AiWallet.find({ tenantId: { $in: ndids } }).lean() : [];
    const byNdid = new Map(wallets.map((w) => [w.tenantId, w]));
    return new Map(ndids.map((ndid) => [ndid, WalletLedgerRepository.view(ndid, byNdid.get(ndid) ?? null)]));
  }

  async totals(): Promise<WalletTotals> {
    const [row] = await AiWallet.aggregate<Omit<WalletTotals, "available">>([
      {
        $group: {
          _id: null,
          wallets: { $sum: 1 },
          suspended: { $sum: { $cond: [{ $eq: ["$status", "suspended"] }, 1, 0] } },
          balance: { $sum: { $ifNull: ["$balance", 0] } },
          reserved: { $sum: { $ifNull: ["$reservedCredits", 0] } },
          totalPurchased: { $sum: { $ifNull: ["$totalPurchased", 0] } },
          totalUsed: { $sum: { $ifNull: ["$totalUsed", 0] } },
        },
      },
      { $project: { _id: 0 } },
    ]);
    const t = row ?? { wallets: 0, suspended: 0, balance: 0, reserved: 0, totalPurchased: 0, totalUsed: 0 };
    return { ...t, available: Math.max(0, t.balance - t.reserved) };
  }

  async lowest(limit: number, below: number): Promise<WalletView[]> {
    const rows = await AiWallet.aggregate<IAiWallet & { available: number }>([
      {
        $addFields: {
          available: {
            $max: [0, { $subtract: [{ $ifNull: ["$balance", 0] }, { $ifNull: ["$reservedCredits", 0] }] }],
          },
        },
      },
      { $match: { available: { $lt: below } } },
      { $sort: { available: 1, tenantId: 1 } },
      { $limit: limit },
    ]);
    return rows.map((w) => WalletLedgerRepository.view(w.tenantId, w));
  }

  async ledger(ndid: string, { limit, before }: { limit: number; before?: string }): Promise<LedgerPage> {
    const filter: Record<string, unknown> = { tenantId: ndid };
    if (before && Types.ObjectId.isValid(before)) filter._id = { $lt: new Types.ObjectId(before) };
    const rows = await AiCreditTransaction.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    const items = rows.slice(0, limit).map(WalletLedgerRepository.entry);
    return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  async usage(ndid: string, from: Date): Promise<UsageSummary> {
    const sums = {
      credits: { $sum: "$chargedCredits" },
      uncollected: { $sum: "$uncollectedCredits" },
      tokens: { $sum: "$totalTokens" },
      // provider cost is only added up in USD (OpenAI and the others gian prices in USD)
      costUsd: { $sum: { $cond: [{ $eq: ["$costCurrency", "USD"] }, "$actualCost", 0] } },
      operations: { $addToSet: "$requestId" },
    };
    const [facets] = await AiUsageLog.aggregate<{
      total: RawUsage[];
      byService: RawUsage[];
      byModel: RawUsage[];
    }>([
      { $match: { tenantId: ndid, createdAt: { $gte: from } } },
      {
        $facet: {
          total: [{ $group: { _id: null, ...sums } }],
          byService: [{ $group: { _id: "$service", ...sums } }, { $sort: { credits: -1 } }],
          byModel: [
            { $group: { _id: { $concat: ["$provider", "/", "$model"] }, ...sums } },
            { $sort: { credits: -1 } },
          ],
        },
      },
    ]);
    const total = facets?.total[0];
    return {
      from,
      credits: total?.credits ?? 0,
      uncollectedCredits: total?.uncollected ?? 0,
      tokens: total?.tokens ?? 0,
      costUsd: total?.costUsd ?? 0,
      operations: total?.operations.length ?? 0,
      byService: (facets?.byService ?? []).map(WalletLedgerRepository.usageRow),
      byModel: (facets?.byModel ?? []).map(WalletLedgerRepository.usageRow),
    };
  }

  async adjust(a: Adjustment, actor: Actor): Promise<AdjustmentResult> {
    const ledgerKey = `adjustment:${a.idempotencyKey}`;
    const replay = async (): Promise<AdjustmentResult | null> => {
      const done = await AiCreditTransaction.findOne({ idempotencyKey: ledgerKey }).lean();
      if (!done) return null;
      if (done.tenantId !== a.ndid) throw new IdempotencyKeyReusedError();
      return {
        transactionId: String(done._id),
        balanceBefore: done.balanceBefore,
        balanceAfter: done.balanceAfter,
        replayed: true,
      };
    };

    const earlier = await replay();
    if (earlier) return earlier;
    await WalletLedgerRepository.ensureWallet(a.ndid);

    try {
      return await inTransaction(async (session) => {
        const isAdd = a.direction === "add";
        const wallet = await AiWallet.findOneAndUpdate(
          isAdd
            ? { tenantId: a.ndid }
            : { tenantId: a.ndid, $expr: { $gte: [{ $subtract: ["$balance", "$reservedCredits"] }, a.amount] } },
          {
            $inc: isAdd
              ? { balance: a.amount, totalAdjustedIn: a.amount }
              : { balance: -a.amount, totalAdjustedOut: a.amount },
          },
          { new: true, session },
        ).lean();
        if (!wallet) {
          const current = await AiWallet.findOne({ tenantId: a.ndid }).session(session).lean();
          throw new InsufficientCreditsError(WalletLedgerRepository.view(a.ndid, current).available);
        }

        const amount = isAdd ? a.amount : -a.amount;
        const balanceBefore = wallet.balance - amount;
        const [tx] = await AiCreditTransaction.create(
          [
            {
              tenantId: a.ndid,
              type: "adjustment",
              amount,
              balanceBefore,
              balanceAfter: wallet.balance,
              description: a.reason,
              referenceId: a.idempotencyKey,
              idempotencyKey: ledgerKey,
              performedBy: actor.email,
            },
          ],
          { session },
        );
        await WalletLedgerRepository.gianAudit(
          actor,
          isAdd ? "credits.add" : "credits.deduct",
          {
            tenantId: a.ndid,
            target: String(tx?._id),
            before: { balance: balanceBefore },
            after: { balance: wallet.balance },
            reason: a.reason,
          },
          session,
        );
        return { transactionId: String(tx?._id), balanceBefore, balanceAfter: wallet.balance, replayed: false };
      });
    } catch (e) {
      // the same key raced in from a second click: the first one won, answer with its result
      if (isDuplicateKey(e)) {
        const replayed = await replay();
        if (replayed) return replayed;
      }
      throw e;
    }
  }

  async setStatus(ndid: string, status: WalletStatus, reason: string, actor: Actor): Promise<{ before: WalletStatus }> {
    await WalletLedgerRepository.ensureWallet(ndid);
    return inTransaction(async (session) => {
      const before = await AiWallet.findOneAndUpdate({ tenantId: ndid }, { $set: { status } }, { session }).lean();
      const previous: WalletStatus = before?.status ?? "active";
      await WalletLedgerRepository.gianAudit(
        actor,
        "wallet.status",
        { tenantId: ndid, before: { status: previous }, after: { status }, reason },
        session,
      );
      return { before: previous };
    });
  }

  /** Same as gian's ensureWallet: create the empty wallet once, with the schema's defaults. */
  private static async ensureWallet(ndid: string): Promise<void> {
    const upsert = () =>
      AiWallet.findOneAndUpdate(
        { tenantId: ndid },
        { $setOnInsert: { tenantId: ndid } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
    try {
      await upsert();
    } catch (e) {
      // two first requests raced on the unique tenantId; the other one created it
      if (!isDuplicateKey(e)) throw e;
    }
    // wallets made by hand in the database may lack these; gian's filters compare them
    await AiWallet.updateOne({ tenantId: ndid, reservedCredits: { $exists: false } }, { $set: { reservedCredits: 0 } });
    await AiWallet.updateOne({ tenantId: ndid, status: { $exists: false } }, { $set: { status: "active" } });
  }

  /** One row in gian's aiadminauditlogs, shaped as gian writes it. */
  static gianAudit(
    actor: Actor,
    action: string,
    data: { tenantId?: string; target?: string; before?: unknown; after?: unknown; reason?: string },
    session?: ClientSession,
  ) {
    return AiAdminAuditLog.create(
      [{ actor: actor.email, action, ip: actor.ip ?? null, ...data }],
      session ? { session } : undefined,
    );
  }

  private static view(ndid: string, w: Partial<IAiWallet> | null): WalletView {
    const balance = w?.balance ?? 0;
    const reservedCredits = w?.reservedCredits ?? 0;
    return {
      ndid,
      exists: Boolean(w),
      balance,
      reservedCredits,
      available: Math.max(0, balance - reservedCredits),
      totalPurchased: w?.totalPurchased ?? 0,
      totalUsed: w?.totalUsed ?? 0,
      totalAdjustedIn: w?.totalAdjustedIn ?? 0,
      totalAdjustedOut: w?.totalAdjustedOut ?? 0,
      status: w?.status ?? "active",
      lastRechargeAt: w?.lastRechargeAt ?? null,
    };
  }

  private static entry(t: IAiCreditTransaction) {
    return {
      id: String(t._id),
      type: t.type,
      amount: t.amount,
      balanceBefore: t.balanceBefore,
      balanceAfter: t.balanceAfter,
      service: t.service ?? null,
      description: t.description,
      referenceId: t.referenceId,
      performedBy: t.performedBy ?? null,
      createdAt: t.createdAt,
    };
  }

  private static usageRow(r: RawUsage): UsageRow {
    return {
      key: String(r._id ?? "unknown"),
      credits: r.credits,
      tokens: r.tokens,
      costUsd: r.costUsd,
      operations: r.operations.length,
    };
  }
}

interface RawUsage {
  _id: unknown;
  credits: number;
  uncollected: number;
  tokens: number;
  costUsd: number;
  operations: string[];
}
