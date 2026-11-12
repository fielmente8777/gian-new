import type { Logger } from "../../../shared/logger/logger.js";
import { CostSyncBusyError } from "../errors/ai-credits.errors.js";
import type { CostSyncService } from "./cost-sync.service.js";

const EVERY_MS = 6 * 60 * 60_000;
const FIRST_RUN_MS = 2 * 60_000;

/**
 * Syncs OpenAI's costs every 6 hours inside the API process (the same way the renewal
 * reminders run). The lock in CostSyncService keeps a second server from syncing at the same
 * time; that server just skips its tick. The first tick waits 2 minutes so a deploy boots fast.
 */
export class CostSyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly sync: Pick<CostSyncService, "run">,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return;
    const first = setTimeout(() => void this.tick(), FIRST_RUN_MS);
    first.unref();
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One run; never two at once in this process, never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const status = await this.sync.run(this.now());
      this.logger.info({ from: status.from, to: status.to, rows: status.rows }, "OpenAI costs synced");
    } catch (err) {
      if (err instanceof CostSyncBusyError) this.logger.debug("OpenAI cost sync skipped: another server is on it");
      else this.logger.error({ err }, "OpenAI cost sync failed");
    } finally {
      this.running = false;
    }
  }
}
