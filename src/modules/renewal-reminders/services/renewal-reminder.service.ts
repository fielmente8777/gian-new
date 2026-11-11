import type { Mailer } from "../../../integrations/mail/mailer.js";
import { WhatsappCloudClient, type WhatsappSender } from "../../../integrations/whatsapp/whatsapp-cloud.client.js";
import type { Logger } from "../../../shared/logger/logger.js";
import type { SubscriptionRecord, SubscriptionsPort } from "../../subscriptions/index.js";
import { NoSubscriptionToRemindError } from "../errors/reminders.errors.js";
import type {
  ChannelResult,
  DueReminder,
  ReminderLogEntry,
  ReminderLogStore,
  ReminderRecipients,
  ReminderRunSummary,
  ReminderSettings,
  ReminderSettingsInput,
  ReminderSettingsStore,
} from "../types/reminders.types.js";
import { ReminderCalendar } from "./reminder-calendar.js";
import { ReminderComposer } from "./reminder-composer.js";

/** More than every subscription Eazotel has today (≈150); a run never loads an unbounded list. */
const MAX_PER_RUN = 2000;

export interface UpcomingReminder extends DueReminder {
  /** the day it goes out, India time */
  sendOn: Date;
}

/**
 * Renewal reminders by email and WhatsApp: some days before the plan ends, on the end day,
 * and some days after for hotels that forgot. Each reminder is claimed in reminder_log
 * before it is sent, so it goes out once even with several servers or a restart mid-run.
 *
 * Nobody is reminded while staff have stopped them (paused, expired by hand, in the trash) or
 * after they cancelled; a hotel with auto-renew on gets no "ends soon" reminder, only the
 * after-end ones if its charge failed. Renewing moves the end date, which ends the series.
 */
export class RenewalReminderService {
  constructor(
    private readonly settingsStore: ReminderSettingsStore,
    private readonly log: ReminderLogStore,
    private readonly subscriptions: Pick<SubscriptionsPort, "endingBetween" | "findByNdid">,
    private readonly recipients: ReminderRecipients,
    private readonly mailer: Mailer,
    private readonly whatsapp: WhatsappSender | null,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get whatsappReady(): boolean {
    return this.whatsapp !== null;
  }

  settings(): Promise<ReminderSettings> {
    return this.settingsStore.get();
  }

  saveSettings(input: ReminderSettingsInput, by: string): Promise<ReminderSettings> {
    const clean = (list: number[]) => [...new Set(list)].sort((a, b) => b - a);
    return this.settingsStore.save(
      { ...input, daysBefore: clean(input.daysBefore), daysAfter: clean(input.daysAfter).reverse() },
      by,
      this.now(),
    );
  }

  history(query: { limit: number; ndid?: string; before?: Date }): Promise<ReminderLogEntry[]> {
    return this.log.list(query);
  }

  /** Sends today's due reminders. Called by the scheduler; safe to call any number of times a day. */
  async runDue(): Promise<ReminderRunSummary> {
    const now = this.now();
    const settings = await this.settingsStore.get();
    const summary: ReminderRunSummary = { ranAt: now, skipped: null, due: 0, sent: 0, alreadySent: 0, failed: 0 };
    if (!settings.enabled) return { ...summary, skipped: "reminders are switched off" };
    if (ReminderCalendar.hour(now) < settings.sendHourIst) return { ...summary, skipped: "too early in the day" };

    for (const due of await this.dueOn(now, settings)) {
      summary.due += 1;
      const key = `${due.ndid}:${ReminderCalendar.dayKey(due.endDate)}:${due.offsetDays}`;
      const result = await this.deliver(due, settings, { key, kind: "scheduled", by: null });
      if (!result) summary.alreadySent += 1;
      else if (result.email.status === "sent" || result.whatsapp.status === "sent") summary.sent += 1;
      else summary.failed += 1;
    }
    if (summary.due) this.logger.info(summary, "renewal reminders run");
    return summary;
  }

  /** What the scheduler will send in the next `days` days, today included. */
  async upcoming(days: number): Promise<UpcomingReminder[]> {
    const settings = await this.settingsStore.get();
    const today = ReminderCalendar.startOfDay(this.now());
    const out: UpcomingReminder[] = [];
    for (let d = 0; d < days; d += 1) {
      const day = new Date(today.getTime() + d * ReminderCalendar.DAY_MS + 12 * 3_600_000);
      for (const due of await this.dueOn(day, settings)) out.push({ ...due, sendOn: ReminderCalendar.startOfDay(day) });
    }
    return out;
  }

  /** A reminder right now from the admin console, whatever the schedule says. */
  async sendNow(ndid: string, by: string): Promise<ReminderLogEntry> {
    const subscription = await this.subscriptions.findByNdid(ndid);
    if (!subscription) throw new NoSubscriptionToRemindError();
    const now = this.now();
    const settings = await this.settingsStore.get();
    const due = RenewalReminderService.toDue(subscription, ReminderCalendar.offset(subscription.endDate, now));
    const result = await this.deliver(due, settings, { key: `manual:${ndid}:${now.getTime()}`, kind: "manual", by });
    // a manual key is new every time, so it is always claimed
    return result!;
  }

  /** The reminders due on `day`'s date, by the settings' offsets. */
  private async dueOn(day: Date, settings: ReminderSettings): Promise<DueReminder[]> {
    const offsets = new Set([
      ...settings.daysBefore.map((d) => -d),
      ...(settings.onEndDay ? [0] : []),
      ...settings.daysAfter,
    ]);
    if (offsets.size === 0) return [];
    const today = ReminderCalendar.startOfDay(day).getTime();
    const furthestBefore = Math.max(0, ...settings.daysBefore);
    const furthestAfter = Math.max(0, ...settings.daysAfter);
    const from = new Date(today - furthestAfter * ReminderCalendar.DAY_MS);
    const to = new Date(today + (furthestBefore + 1) * ReminderCalendar.DAY_MS);

    const due: DueReminder[] = [];
    for (const s of await this.subscriptions.endingBetween(from, to, MAX_PER_RUN)) {
      const offset = ReminderCalendar.offset(s.endDate, day);
      if (!offsets.has(offset)) continue;
      if (s.staffStop || s.status === "CANCELLED") continue;
      const reminder = RenewalReminderService.toDue(s, offset);
      if (reminder.trial && !settings.includeTrial) continue;
      // auto-renew charges it at the end; only remind if that charge didn't happen
      if (s.autoRenew && offset <= 0) continue;
      due.push(reminder);
    }
    return due;
  }

  /** Claims the key, then sends on each channel. Null when the key was already taken. */
  private async deliver(
    due: DueReminder,
    settings: ReminderSettings,
    { key, kind, by }: { key: string; kind: ReminderLogEntry["kind"]; by: string | null },
  ): Promise<ReminderLogEntry | null> {
    const pending: ChannelResult = { status: "skipped", to: [], note: "not sent yet" };
    const entry = {
      key,
      ndid: due.ndid,
      hotelName: due.hotelName,
      planName: due.planName,
      endDate: due.endDate,
      offsetDays: due.offsetDays,
      kind,
      email: pending,
      whatsapp: pending,
      by,
      sentAt: this.now(),
    };
    if (!(await this.log.claim(entry))) return null;

    const people = await this.recipients(due.ndid).catch((err: unknown) => {
      this.logger.warn({ err, ndid: due.ndid }, "reminder recipients lookup failed");
      return { hotelName: due.hotelName, emails: [] as string[], phones: [] as string[] };
    });
    const message = ReminderComposer.compose(
      { ...due, hotelName: people.hotelName ?? due.hotelName },
      settings.renewUrl,
    );
    const email = await this.sendEmail(settings, people.emails, message);
    const whatsapp = await this.sendWhatsapp(settings, people.phones, message.whatsappParams);
    const sentAt = this.now();
    await this.log.finish(key, { email, whatsapp, sentAt });
    return { id: "", ...entry, email, whatsapp, sentAt };
  }

  private async sendEmail(
    settings: ReminderSettings,
    emails: string[],
    message: { subject: string; text: string },
  ): Promise<ChannelResult> {
    if (!settings.channels.email) return { status: "skipped", to: [], note: "email reminders are off" };
    const to = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (!to.length) return { status: "skipped", to: [], note: "no email address on file" };
    const failed: string[] = [];
    for (const address of to) {
      try {
        await this.mailer.send({ to: address, subject: message.subject, text: message.text });
      } catch (err) {
        failed.push(address);
        this.logger.warn({ err, to: address }, "reminder email failed");
      }
    }
    if (failed.length === to.length) return { status: "failed", to, note: "the mail server refused it" };
    return {
      status: "sent",
      to: to.filter((a) => !failed.includes(a)),
      note: failed.length ? `failed for ${failed.join(", ")}` : null,
    };
  }

  private async sendWhatsapp(settings: ReminderSettings, phones: string[], params: string[]): Promise<ChannelResult> {
    if (!settings.channels.whatsapp) return { status: "skipped", to: [], note: "WhatsApp reminders are off" };
    if (!this.whatsapp) return { status: "skipped", to: [], note: "the WhatsApp number is not set up on the server" };
    const to = [
      ...new Set(phones.map((p) => WhatsappCloudClient.normalisePhone(p)).filter((p): p is string => p !== null)),
    ];
    if (!to.length) return { status: "skipped", to: [], note: "no phone number on file" };
    const sent: string[] = [];
    let lastError = "";
    for (const phone of to) {
      try {
        await this.whatsapp.sendTemplate({
          to: phone,
          template: settings.whatsappTemplate.name,
          language: settings.whatsappTemplate.language,
          params,
        });
        sent.push(phone);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn({ err, to: phone }, "reminder WhatsApp failed");
      }
    }
    if (!sent.length) return { status: "failed", to, note: lastError || "WhatsApp refused it" };
    return { status: "sent", to: sent, note: sent.length < to.length ? `failed for some numbers: ${lastError}` : null };
  }

  private static toDue(s: SubscriptionRecord, offsetDays: number): DueReminder {
    const planName = s.plan?.name ?? null;
    return {
      ndid: s.ndid,
      hotelName: s.hotelName,
      planName,
      endDate: s.endDate,
      offsetDays,
      trial: s.status === "TRIAL" || planName?.toUpperCase() === "TRIAL",
    };
  }
}
