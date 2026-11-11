/**
 * When and how hotels are reminded about their plan's end. One document, reminder_settings
 * `_id: "default"`, edited from the admin console (Billing → Reminders).
 */
export interface ReminderSettings {
  /** off until staff switch it on, so a deploy never starts messaging hotels by itself */
  enabled: boolean;
  /** days before the end date, e.g. [7, 3, 1] */
  daysBefore: number[];
  /** on the end date itself */
  onEndDay: boolean;
  /** days after it ended, for hotels that forgot to renew, e.g. [1, 3, 7] */
  daysAfter: number[];
  channels: { email: boolean; whatsapp: boolean };
  /** the approved WhatsApp template; its body takes 4 values: hotel, plan, when, link */
  whatsappTemplate: { name: string; language: string };
  /** also remind hotels whose free trial is ending */
  includeTrial: boolean;
  /** hour of the day in India time from which the day's reminders go out (0–23) */
  sendHourIst: number;
  /** where "Renew now" goes: the hotel dashboard's plans page; empty = no link */
  renewUrl: string;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export type ReminderSettingsInput = Omit<ReminderSettings, "updatedAt" | "updatedBy">;

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: false,
  daysBefore: [7, 3, 1],
  onEndDay: true,
  daysAfter: [1, 3, 7],
  channels: { email: true, whatsapp: false },
  whatsappTemplate: { name: "subscription_reminder", language: "en" },
  includeTrial: true,
  sendHourIst: 10,
  renewUrl: "",
  updatedAt: null,
  updatedBy: null,
};

/** How one channel went for one reminder. */
export interface ChannelResult {
  status: "sent" | "failed" | "skipped";
  to: string[];
  /** why it failed or was skipped */
  note: string | null;
}

/**
 * One reminder (reminder_log). `key` is unique: the same reminder for the same end date is
 * never sent twice, however many servers run the scheduler.
 */
export interface ReminderLogEntry {
  id: string;
  key: string;
  ndid: string;
  hotelName: string | null;
  planName: string | null;
  endDate: Date;
  /** days from the end date: -7 = a week before, 0 = the end day, 3 = three days after */
  offsetDays: number;
  kind: "scheduled" | "manual";
  email: ChannelResult;
  whatsapp: ChannelResult;
  /** staff email for a manual one */
  by: string | null;
  sentAt: Date;
}

export type NewReminderLogEntry = Omit<ReminderLogEntry, "id">;

export interface ReminderSettingsStore {
  get(): Promise<ReminderSettings>;
  save(input: ReminderSettingsInput, by: string, now: Date): Promise<ReminderSettings>;
}

export interface ReminderLogStore {
  /** Reserves the key before sending; false when this reminder was already sent (or is being sent). */
  claim(entry: NewReminderLogEntry): Promise<boolean>;
  /** Fills in how each channel went. */
  finish(key: string, result: Pick<ReminderLogEntry, "email" | "whatsapp" | "sentAt">): Promise<void>;
  list(query: { limit: number; ndid?: string; before?: Date }): Promise<ReminderLogEntry[]>;
}

/** Who gets a hotel's reminders: the hotel and its account holder. */
export type ReminderRecipients = (
  ndid: string,
) => Promise<{ hotelName: string | null; emails: string[]; phones: string[] }>;

/** A reminder that is due (or was sent by hand). */
export interface DueReminder {
  ndid: string;
  hotelName: string | null;
  planName: string | null;
  endDate: Date;
  offsetDays: number;
  trial: boolean;
}

/** One scheduled run, for the logs and the admin console. */
export interface ReminderRunSummary {
  ranAt: Date;
  skipped: string | null;
  due: number;
  sent: number;
  alreadySent: number;
  failed: number;
}
