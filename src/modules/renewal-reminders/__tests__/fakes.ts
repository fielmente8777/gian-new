import { pino } from "pino";

import type { WhatsappSender } from "../../../integrations/whatsapp/whatsapp-cloud.client.js";
import { RenewalReminderService } from "../services/renewal-reminder.service.js";
import {
  DEFAULT_REMINDER_SETTINGS,
  type NewReminderLogEntry,
  type ReminderLogEntry,
  type ReminderLogStore,
  type ReminderSettings,
  type ReminderSettingsInput,
  type ReminderSettingsStore,
} from "../types/reminders.types.js";

export class InMemoryReminderSettings implements ReminderSettingsStore {
  value: ReminderSettings = { ...DEFAULT_REMINDER_SETTINGS };

  async get() {
    return { ...this.value };
  }

  async save(input: ReminderSettingsInput, by: string, now: Date) {
    this.value = { ...input, updatedAt: now, updatedBy: by };
    return this.get();
  }
}

export class InMemoryReminderLog implements ReminderLogStore {
  readonly rows: ReminderLogEntry[] = [];

  async claim(entry: NewReminderLogEntry) {
    if (this.rows.some((r) => r.key === entry.key)) return false;
    this.rows.push({ id: `r${this.rows.length + 1}`, ...entry });
    return true;
  }

  async finish(key: string, result: Pick<ReminderLogEntry, "email" | "whatsapp" | "sentAt">) {
    const row = this.rows.find((r) => r.key === key);
    if (row) Object.assign(row, result);
  }

  async list({ limit, ndid }: { limit: number; ndid?: string }) {
    return [...this.rows]
      .filter((r) => !ndid || r.ndid === ndid)
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())
      .slice(0, limit);
  }
}

/** Records every template message; `failing` makes Meta refuse them. */
export class FakeWhatsapp implements WhatsappSender {
  readonly sent: { to: string; template: string; language: string; params: string[] }[] = [];
  failing = false;

  async sendTemplate(input: { to: string; template: string; language: string; params: string[] }) {
    if (this.failing) throw new Error("(#132001) Template name does not exist in the translation");
    this.sent.push(input);
    return `wamid.${this.sent.length}`;
  }
}

/** A working reminder service over in-memory stores, for the admin module's tests. */
export class TestReminders {
  static create(
    subscriptions: ConstructorParameters<typeof RenewalReminderService>[2],
    mailbox: ConstructorParameters<typeof RenewalReminderService>[4],
  ) {
    const settings = new InMemoryReminderSettings();
    const log = new InMemoryReminderLog();
    const whatsapp = new FakeWhatsapp();
    const port = new RenewalReminderService(
      settings,
      log,
      subscriptions,
      async (ndid) => ({ hotelName: null, emails: [`${ndid}@hotel.test`], phones: ["9876543210"] }),
      mailbox,
      whatsapp,
      pino({ level: "silent" }),
    );
    return { port, settings, log, whatsapp };
  }
}
