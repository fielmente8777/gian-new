import type {
  CreditCatalogueStore,
  PoolAlertKind,
  PoolSettings,
  PoolStateStore,
  ProviderCostStore,
  SyncStatus,
  TopUpStore,
  TrackedCostStore,
  WalletStore,
  WalletTotals,
} from "../types/ai-credits.types.js";
import { UtcDays } from "./utc-days.js";

const round = (n: number, places = 4) => Number(n.toFixed(places));

/** The company's OpenAI account as the console's AI credits overview shows it. */
export interface PoolOverview {
  openai: {
    /** false: OPENAI_ADMIN_KEY is not set, so no cost data comes in */
    configured: boolean;
    lastSync: SyncStatus | null;
    topUpsUsd: number;
    /** the first top-up's day: spend is counted from here. Null before any top-up is recorded. */
    trackedSince: string | null;
    spentUsd: number;
    /** top-ups - spend since trackedSince; null before any top-up */
    remainingUsd: number | null;
    spend: { todayUsd: number; last7Usd: number; last30Usd: number };
    /** average of the last 7 full UTC days */
    avgDailyUsd: number;
    /** how many days the remaining pool lasts at avgDailyUsd; null when unknown */
    runwayDays: number | null;
  };
  credits: WalletTotals;
  coverage: {
    /** average credits per USD over the active USD price rows; null without any */
    creditsPerUsd: number | null;
    /** what the clients' unused credits would cost us at OpenAI if all were spent */
    liabilityUsd: number | null;
    /** remaining pool / liability. Below 1: the pool can't cover every credit already sold. */
    ratio: number | null;
  };
  alerts: PoolAlertKind[];
  settings: PoolSettings;
}

export interface ReconciliationDay {
  date: string;
  /** what OpenAI's Costs API says we were charged */
  openaiUsd: number;
  /** what gian recorded for its OpenAI calls (aiprovidercalls) */
  trackedUsd: number;
  /** the part billed to client wallets (aiusagelogs) */
  billedUsd: number;
  /** openaiUsd - trackedUsd: usage gian didn't record or price */
  gapUsd: number;
  calls: number;
}

export interface Reconciliation {
  from: string;
  to: string;
  days: ReconciliationDay[];
  totals: Omit<ReconciliationDay, "date">;
  lineItems: { lineItem: string; amountUsd: number }[];
}

/**
 * Works out the OpenAI pool. OpenAI has no API for the prepaid balance, so:
 *
 *   remaining = sum(top-ups staff recorded) - OpenAI's reported cost since the first top-up
 *
 * Record the balance OpenAI shows on the day tracking starts as the first top-up, then every
 * later payment. Spend comes from ai_provider_cost_daily (filled by CostSyncService).
 */
export class AiPoolService {
  constructor(
    private readonly costs: ProviderCostStore,
    private readonly tracked: TrackedCostStore,
    private readonly topUps: TopUpStore,
    private readonly wallets: Pick<WalletStore, "totals">,
    private readonly catalogue: Pick<CreditCatalogueStore, "listPricing">,
    private readonly state: Pick<PoolStateStore, "getSettings" | "lastSync">,
    private readonly configured: boolean,
  ) {}

  async overview(now: Date): Promise<PoolOverview> {
    const today = UtcDays.of(now);
    const [topUps, settings, lastSync, credits, pricing, recent] = await Promise.all([
      this.topUps.list(),
      this.state.getSettings(),
      this.state.lastSync(),
      this.wallets.totals(),
      this.catalogue.listPricing(),
      this.costs.dailyTotals(UtcDays.add(today, -29), today),
    ]);

    const topUpsUsd = topUps.reduce((sum, t) => sum + t.amountUsd, 0);
    const trackedSince = topUps.length ? topUps.map((t) => t.paidOn).sort()[0]! : null;
    const spentUsd = trackedSince ? await this.costs.sumSince(trackedSince) : 0;
    const remainingUsd = trackedSince ? topUpsUsd - spentUsd : null;

    const spentFrom = (from: string, to = today) =>
      recent.filter((d) => d.date >= from && d.date <= to).reduce((sum, d) => sum + d.amountUsd, 0);
    const avgDailyUsd = spentFrom(UtcDays.add(today, -7), UtcDays.add(today, -1)) / 7;
    const runwayDays = remainingUsd !== null && avgDailyUsd > 0 ? Math.max(0, remainingUsd) / avgDailyUsd : null;

    const usdRates = pricing
      .filter((p) => p.status === "active" && p.currency === "USD" && p.creditConversionRate > 0)
      .map((p) => p.creditConversionRate);
    const creditsPerUsd = usdRates.length ? usdRates.reduce((a, b) => a + b, 0) / usdRates.length : null;
    const liabilityUsd = creditsPerUsd ? credits.available / creditsPerUsd : null;
    const ratio = remainingUsd !== null && liabilityUsd ? remainingUsd / liabilityUsd : null;

    const alerts: PoolAlertKind[] = [];
    if (remainingUsd !== null && remainingUsd < settings.lowPoolUsd) alerts.push("low_pool");
    if (runwayDays !== null && runwayDays < settings.lowRunwayDays) alerts.push("low_runway");

    return {
      openai: {
        configured: this.configured,
        lastSync,
        topUpsUsd: round(topUpsUsd),
        trackedSince,
        spentUsd: round(spentUsd),
        remainingUsd: remainingUsd === null ? null : round(remainingUsd),
        spend: {
          todayUsd: round(spentFrom(today)),
          last7Usd: round(spentFrom(UtcDays.add(today, -6))),
          last30Usd: round(spentFrom(UtcDays.add(today, -29))),
        },
        avgDailyUsd: round(avgDailyUsd),
        runwayDays: runwayDays === null ? null : round(runwayDays, 1),
      },
      credits,
      coverage: {
        creditsPerUsd: creditsPerUsd === null ? null : round(creditsPerUsd, 2),
        liabilityUsd: liabilityUsd === null ? null : round(liabilityUsd),
        ratio: ratio === null ? null : round(ratio, 2),
      },
      alerts,
      settings,
    };
  }

  /** OpenAI's bill next to what gian recorded, per UTC day, for the last `days` days. */
  async reconcile(days: number, now: Date): Promise<Reconciliation> {
    const to = UtcDays.of(now);
    const from = UtcDays.add(to, -(days - 1));
    const [openai, tracked, lineItems] = await Promise.all([
      this.costs.dailyTotals(from, to),
      this.tracked.daily(UtcDays.start(from), UtcDays.start(UtcDays.add(to, 1))),
      this.costs.lineItems(from, to),
    ]);
    const openaiByDay = new Map(openai.map((d) => [d.date, d.amountUsd]));
    const trackedByDay = new Map(tracked.map((d) => [d.date, d]));
    const rows = UtcDays.range(from, to).map((date): ReconciliationDay => {
      const o = openaiByDay.get(date) ?? 0;
      const t = trackedByDay.get(date);
      return {
        date,
        openaiUsd: round(o),
        trackedUsd: round(t?.trackedUsd ?? 0),
        billedUsd: round(t?.billedUsd ?? 0),
        gapUsd: round(o - (t?.trackedUsd ?? 0)),
        calls: t?.calls ?? 0,
      };
    });
    const sum = (k: "openaiUsd" | "trackedUsd" | "billedUsd" | "gapUsd" | "calls") =>
      round(rows.reduce((s, r) => s + r[k], 0));
    return {
      from,
      to,
      days: rows,
      totals: {
        openaiUsd: sum("openaiUsd"),
        trackedUsd: sum("trackedUsd"),
        billedUsd: sum("billedUsd"),
        gapUsd: sum("gapUsd"),
        calls: sum("calls"),
      },
      lineItems: lineItems.map((l) => ({ ...l, amountUsd: round(l.amountUsd) })),
    };
  }
}
