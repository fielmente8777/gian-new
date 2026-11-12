import { Types } from "mongoose";

import {
  AiAdminAuditLog,
  AiProviderCall,
  AiUsageLog,
  type IAiAdminAuditLog,
} from "../models/gian-ai-credits.models.js";
import type { GianAuditEntry, GianAuditStore, TrackedCostDay, TrackedCostStore } from "../types/ai-credits.types.js";

const day = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } };

/**
 * What gian itself recorded about its OpenAI calls, per UTC day, read-only:
 *   aiprovidercalls  every call, billed to a client or not (trackedUsd, calls)
 *   aiusagelogs      the part billed to a client wallet (billedUsd)
 * Both carry the cost gian worked out from aipricings at the time, so a model without a price
 * row shows 0 here even though OpenAI charged for it. That gap is what reconciliation is for.
 */
export class TrackedCostRepository implements TrackedCostStore {
  async daily(from: Date, to: Date): Promise<TrackedCostDay[]> {
    const match = { provider: "openai", createdAt: { $gte: from, $lt: to } };
    const [calls, billed] = await Promise.all([
      AiProviderCall.aggregate<{ _id: string; usd: number; calls: number }>([
        { $match: match },
        {
          $group: {
            _id: day,
            usd: { $sum: { $cond: [{ $eq: ["$costCurrency", "USD"] }, "$cost", 0] } },
            calls: { $sum: 1 },
          },
        },
      ]),
      AiUsageLog.aggregate<{ _id: string; usd: number }>([
        { $match: match },
        { $group: { _id: day, usd: { $sum: { $cond: [{ $eq: ["$costCurrency", "USD"] }, "$actualCost", 0] } } } },
      ]),
    ]);
    const days = new Map<string, TrackedCostDay>();
    const get = (date: string) => {
      const row = days.get(date) ?? { date, trackedUsd: 0, billedUsd: 0, calls: 0 };
      days.set(date, row);
      return row;
    };
    for (const c of calls) Object.assign(get(c._id), { trackedUsd: c.usd, calls: c.calls });
    for (const b of billed) get(b._id).billedUsd = b.usd;
    return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}

/** gian's aiadminauditlogs, newest first: its own dashboard admin page's changes and ours. */
export class GianAuditRepository implements GianAuditStore {
  async list({ limit, before, tenantId }: { limit: number; before?: string; tenantId?: string }) {
    const filter: Record<string, unknown> = {};
    if (tenantId) filter.tenantId = tenantId;
    if (before && /^[a-f\d]{24}$/i.test(before)) filter._id = { $lt: new Types.ObjectId(before) };
    const rows = await AiAdminAuditLog.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean<(IAiAdminAuditLog & { _id: Types.ObjectId })[]>();
    const items: GianAuditEntry[] = rows.slice(0, limit).map((r) => ({
      id: String(r._id),
      actor: r.actor,
      action: r.action,
      tenantId: r.tenantId ?? null,
      target: r.target ?? null,
      before: r.before ?? null,
      after: r.after ?? null,
      reason: r.reason ?? null,
      ip: r.ip ?? null,
      createdAt: r.createdAt,
    }));
    return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }
}
