/** Date maths for billing periods. */
export class BillingDates {
  /**
   * Adds calendar months. A day that doesn't exist in the target month moves to its last day
   * (31 Jan + 1 month = 28/29 Feb), so a period is never longer than it should be.
   */
  static addMonths(from: Date, months: number): Date {
    const date = new Date(from);
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    return date;
  }

  static daysBetween(from: Date, to: Date): number {
    return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
  }
}
