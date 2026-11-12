import type { Mailer } from "../../../integrations/mail/mailer.js";
import type { Logger } from "../../../shared/logger/logger.js";
import type { AlertRecipients, PoolAlertKind, PoolStateStore } from "../types/ai-credits.types.js";
import type { AiPoolService, PoolOverview } from "./ai-pool.service.js";

const REPEAT_AFTER_MS = 24 * 60 * 60_000;

/**
 * Emails the super admins (and any extra addresses in the pool settings) when the OpenAI pool
 * runs low: below `lowPoolUsd`, or lasting fewer than `lowRunwayDays` at the last 7 days'
 * spend. Each condition is sent at most once per 24 hours, however often the sync runs.
 */
export class PoolAlertService {
  constructor(
    private readonly pool: Pick<AiPoolService, "overview">,
    private readonly state: Pick<PoolStateStore, "lastAlert" | "markAlert">,
    private readonly recipients: AlertRecipients,
    private readonly mailer: Mailer,
    private readonly logger: Logger,
    private readonly consoleUrl: string | null,
  ) {}

  /** Sends what is due; returns the conditions that were emailed. */
  async check(now: Date): Promise<PoolAlertKind[]> {
    const overview = await this.pool.overview(now);
    const due: PoolAlertKind[] = [];
    for (const kind of overview.alerts) {
      const last = await this.state.lastAlert(kind);
      if (!last || now.getTime() - last.getTime() >= REPEAT_AFTER_MS) due.push(kind);
    }
    if (due.length === 0) return [];

    const to = [...new Set([...(await this.recipients()), ...overview.settings.alertEmails])];
    if (to.length === 0) {
      this.logger.warn({ alerts: due }, "OpenAI pool is low but there is nobody to email");
      return [];
    }
    const message = PoolAlertService.compose(due, overview, this.consoleUrl);
    for (const address of to) {
      try {
        await this.mailer.send({ to: address, ...message });
      } catch (err) {
        this.logger.error({ err, to: address }, "could not send the OpenAI pool alert");
      }
    }
    for (const kind of due) await this.state.markAlert(kind, now);
    this.logger.warn({ alerts: due, remainingUsd: overview.openai.remainingUsd }, "OpenAI pool alert sent");
    return due;
  }

  static compose(kinds: PoolAlertKind[], o: PoolOverview, consoleUrl: string | null) {
    const usd = (n: number | null) => (n === null ? "unknown" : `$${n.toFixed(2)}`);
    const lines = [
      "The company OpenAI account is running low.",
      "",
      `Remaining (top-ups minus spend): ${usd(o.openai.remainingUsd)}`,
      `Average daily spend, last 7 days: ${usd(o.openai.avgDailyUsd)}`,
      `Runway: ${o.openai.runwayDays === null ? "unknown" : `${o.openai.runwayDays} days`}`,
      `Unused client credits would cost: ${usd(o.coverage.liabilityUsd)}`,
      "",
      ...kinds.map((k) =>
        k === "low_pool"
          ? `- Below the $${o.settings.lowPoolUsd} alert level.`
          : `- Lasts fewer than ${o.settings.lowRunwayDays} days.`,
      ),
      "",
      "Top up the OpenAI account, then record the top-up in the admin console (AI credits > OpenAI).",
      ...(consoleUrl ? [`${consoleUrl.replace(/\/$/, "")}/ai-credits`] : []),
    ];
    return { subject: "OpenAI credit pool is running low", text: lines.join("\n") };
  }
}
