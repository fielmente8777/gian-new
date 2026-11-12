import { randomUUID } from "node:crypto";

import type { Logger } from "../../../shared/logger/logger.js";
import { CostSyncBusyError, OpenAiNotConfiguredError } from "../errors/ai-credits.errors.js";
import type {
  DailyCost,
  OpenAiCosts,
  PoolStateStore,
  ProviderCostStore,
  SyncStatus,
} from "../types/ai-credits.types.js";
import type { PoolAlertService } from "./pool-alert.service.js";
import { UtcDays } from "./utc-days.js";

const LOCK = "cost-sync";
const LOCK_MS = 10 * 60_000;
/** first run: this many days back, today included */
const BACKFILL_DAYS = 30;
/** OpenAI keeps revising the last couple of days, so every run fetches these again */
const REFETCH_DAYS = 3;

/**
 * Copies OpenAI's daily costs into ai_provider_cost_daily, then checks the pool alerts.
 *
 *   - one server at a time: a lock in ai_credits_state, held for at most 10 minutes
 *   - the first run takes the last 30 days; later runs re-fetch the last 3 days (and any gap
 *     since the last saved day), because OpenAI fills in and corrects recent days late
 *   - each fetched day is replaced as a whole, so running twice changes nothing
 */
export class CostSyncService {
  constructor(
    private readonly client: OpenAiCosts | null,
    private readonly costs: ProviderCostStore,
    private readonly state: Pick<PoolStateStore, "acquireLock" | "releaseLock" | "saveSync">,
    private readonly alerts: Pick<PoolAlertService, "check"> | null,
    private readonly logger: Logger,
  ) {}

  get configured(): boolean {
    return this.client !== null;
  }

  async run(now: Date): Promise<SyncStatus> {
    if (!this.client) throw new OpenAiNotConfiguredError();
    const owner = randomUUID();
    if (!(await this.state.acquireLock(LOCK, owner, new Date(now.getTime() + LOCK_MS), now))) {
      throw new CostSyncBusyError();
    }
    try {
      const today = UtcDays.of(now);
      const latest = await this.costs.latestDate();
      const from = latest
        ? UtcDays.add(latest < today ? latest : today, -(REFETCH_DAYS - 1))
        : UtcDays.add(today, -(BACKFILL_DAYS - 1));
      const days = UtcDays.range(from, today);

      let status: SyncStatus;
      try {
        const lines = await this.client.costs(UtcDays.unix(from), UtcDays.unix(UtcDays.add(today, 1)));
        const rows = CostSyncService.merge(
          lines.map((l) => ({ ...l, date: UtcDays.of(new Date(l.startTime * 1000)) })),
        );
        await this.costs.replaceDays(days, rows, now);
        status = { at: now, ok: true, from, to: today, rows: rows.length, error: null };
      } catch (err) {
        const code = (err as { code?: string }).code ?? "OPENAI_SYNC_FAILED";
        status = { at: now, ok: false, from, to: today, rows: 0, error: code };
        await this.state.saveSync(status);
        throw err;
      }
      await this.state.saveSync(status);

      try {
        await this.alerts?.check(now);
      } catch (err) {
        this.logger.error({ err }, "OpenAI pool alert check failed");
      }
      return status;
    } finally {
      await this.state.releaseLock(LOCK, owner);
    }
  }

  /** One row per day + line item + project, adding up any that OpenAI split across pages. */
  private static merge(lines: (DailyCost & { startTime: number })[]): DailyCost[] {
    const rows = new Map<string, DailyCost>();
    for (const { date, lineItem, projectId, amountUsd } of lines) {
      const key = `${date}|${lineItem}|${projectId ?? "-"}`;
      const row = rows.get(key);
      if (row) row.amountUsd += amountUsd;
      else rows.set(key, { date, lineItem, projectId, amountUsd });
    }
    return [...rows.values()];
  }
}
