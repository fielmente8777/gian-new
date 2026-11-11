import type { DueReminder } from "../types/reminders.types.js";
import { ReminderCalendar } from "./reminder-calendar.js";

export interface ComposedReminder {
  subject: string;
  text: string;
  /** the WhatsApp template's 4 values: hotel, plan, when, where to renew */
  whatsappParams: [string, string, string, string];
}

const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

/**
 * The words of a reminder, the same in the email and on WhatsApp. Before the end it asks to
 * renew in time; on and after the end it says the services are paused and the data is safe.
 */
export class ReminderComposer {
  static compose(due: DueReminder, renewUrl: string): ComposedReminder {
    const plan = due.trial ? "free trial" : `${due.planName ?? "Eazotel"} plan`;
    const date = ReminderCalendar.label(due.endDate);
    const o = due.offsetDays;
    const when = o < 0 ? `ends on ${date}, in ${days(-o)}` : o === 0 ? `ends today, ${date}` : `ended on ${date}`;
    const subject =
      o < 0
        ? `Your Eazotel ${plan} ends in ${days(-o)}`
        : o === 0
          ? `Your Eazotel ${plan} ends today`
          : `Your Eazotel ${plan} has ended: renew to switch your services back on`;
    const link = renewUrl.trim();
    const where = link || "your Eazotel dashboard, under Settings → Subscription";

    const text = [
      `Hello${due.hotelName ? ` ${due.hotelName}` : ""},`,
      "",
      `Your Eazotel ${plan} ${when}.`,
      "",
      o < 0
        ? "Renew before then and nothing stops: your chatbot, lead alerts and every app keep running, and the new period starts where this one ends, so you lose no days."
        : o === 0
          ? "Renew today to keep your chatbot, lead alerts and apps running without a break."
          : "Your chatbot, lead alerts and apps are paused until you renew. Your data and settings are safe, and everything switches back on as soon as the payment is through.",
      "",
      `Renew here: ${where}`,
      "",
      "Questions? Just reply to this email.",
      "",
      "Team Eazotel",
    ].join("\n");

    return { subject, text, whatsappParams: [due.hotelName ?? "there", plan, when, where] };
  }
}
