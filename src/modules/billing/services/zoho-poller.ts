import type { Logger } from "../../../shared/logger/logger.js";
import type { ZohoSyncService } from "./zoho-sync.service.js";

const EVERY_MS = 30 * 60_000;

/**
 * Every 30 minutes, reads Zoho Books' recently paid invoices and applies any the webhook
 * missed (a webhook not set up, Zoho retrying late, our server restarting). Applying is
 * once-only, so overlapping with the webhook is harmless. Does nothing while not connected.
 */
export class ZohoPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly sync: Pick<ZohoSyncService, "syncRecent">,
    private readonly connected: () => Promise<boolean>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (await this.connected()) await this.sync.syncRecent();
    } catch (err) {
      this.logger.warn({ err }, "Zoho Books sync failed; will try again in 30 minutes");
    } finally {
      this.running = false;
    }
  }
}
