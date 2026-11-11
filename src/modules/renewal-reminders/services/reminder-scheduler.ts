import type { Logger } from "../../../shared/logger/logger.js";
import type { RenewalReminderService } from "./renewal-reminder.service.js";

const EVERY_MS = 15 * 60_000;

/**
 * Runs the day's reminders every 15 minutes inside the API process. Each run only sends what
 * reminder_log hasn't seen, so the 15-minute ticks, a restart or a second server never repeat
 * one. The first tick waits a minute so a deploy's boot isn't slowed down.
 */
export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly reminders: Pick<RenewalReminderService, "runDue">,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    const first = setTimeout(() => void this.tick(), 60_000);
    first.unref();
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One run; never two at once, never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reminders.runDue();
    } catch (err) {
      this.logger.error({ err }, "renewal reminders run failed");
    } finally {
      this.running = false;
    }
  }
}
