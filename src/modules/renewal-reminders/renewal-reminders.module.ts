import type { Mailer } from "../../integrations/mail/mailer.js";
import type { WhatsappSender } from "../../integrations/whatsapp/whatsapp-cloud.client.js";
import type { Logger } from "../../shared/logger/logger.js";
import type { AppModule } from "../../shared/module/app-module.js";
import type { SubscriptionsPort } from "../subscriptions/index.js";
import { ReminderLogRepository, ReminderSettingsRepository } from "./repositories/reminder.repositories.js";
import { RenewalReminderService } from "./services/renewal-reminder.service.js";
import { ReminderScheduler } from "./services/reminder-scheduler.js";
import type { ReminderLogStore, ReminderRecipients, ReminderSettingsStore } from "./types/reminders.types.js";

export interface RenewalRemindersModuleDeps {
  logger: Logger;
  mailer: Mailer;
  /** Eazotel's own WhatsApp number; null = email only */
  whatsapp: WhatsappSender | null;
  subscriptions: Pick<SubscriptionsPort, "endingBetween" | "findByNdid">;
  recipients: ReminderRecipients;
  /** false in tests and one-off scripts: nothing runs on a timer */
  schedule: boolean;
  overrides?: { settings?: ReminderSettingsStore; log?: ReminderLogStore; now?: () => Date };
}

/**
 * Reminds hotels by email and WhatsApp before and after their plan ends. The admin console
 * edits the schedule and can send one by hand (admin module). See the README in this folder.
 * Owns: reminder_settings, reminder_log.
 */
export class RenewalRemindersModule implements AppModule {
  readonly name = "renewal-reminders";
  readonly port: RenewalReminderService;
  private readonly log: ReminderLogStore;
  private readonly scheduler: ReminderScheduler | null;

  constructor(deps: RenewalRemindersModuleDeps) {
    const { overrides = {} } = deps;
    this.log = overrides.log ?? new ReminderLogRepository();
    this.port = new RenewalReminderService(
      overrides.settings ?? new ReminderSettingsRepository(),
      this.log,
      deps.subscriptions,
      deps.recipients,
      deps.mailer,
      deps.whatsapp,
      deps.logger,
      overrides.now,
    );
    this.scheduler = deps.schedule ? new ReminderScheduler(this.port, deps.logger) : null;
  }

  async init(): Promise<void> {
    if (this.log instanceof ReminderLogRepository) await this.log.ensureIndexes();
    this.scheduler?.start();
  }

  async shutdown(): Promise<void> {
    this.scheduler?.stop();
  }
}
