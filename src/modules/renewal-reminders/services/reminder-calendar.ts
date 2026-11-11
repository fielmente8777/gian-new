const DAY_MS = 86_400_000;
/** India Standard Time, +05:30, no daylight saving */
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** Day arithmetic in India time, where hotels and the team live. */
export class ReminderCalendar {
  static readonly DAY_MS = DAY_MS;

  /** Midnight India time of the day `at` falls on. */
  static startOfDay(at: Date): Date {
    return new Date(Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS);
  }

  static hour(at: Date): number {
    return new Date(at.getTime() + IST_OFFSET_MS).getUTCHours();
  }

  /** Whole days from the end date's day to today's: -3 = ends in 3 days, 0 = ends today, 2 = ended 2 days ago. */
  static offset(endDate: Date, now: Date): number {
    return Math.round((this.startOfDay(now).getTime() - this.startOfDay(endDate).getTime()) / DAY_MS);
  }

  /** "2026-11-18": the end date's day in India time, part of a reminder's key */
  static dayKey(at: Date): string {
    return new Date(this.startOfDay(at).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  }

  static label(at: Date): string {
    return at.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  }
}
