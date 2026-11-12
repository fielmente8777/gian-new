const DAY_MS = 86_400_000;

/**
 * Calendar days as YYYY-MM-DD in UTC. OpenAI's cost buckets are UTC days, so every stored
 * date and every comparison with OpenAI uses UTC; the console shows them with a "UTC" note.
 */
export class UtcDays {
  static of(at: Date): string {
    return at.toISOString().slice(0, 10);
  }

  static start(date: string): Date {
    return new Date(`${date}T00:00:00.000Z`);
  }

  static add(date: string, days: number): string {
    return UtcDays.of(new Date(UtcDays.start(date).getTime() + days * DAY_MS));
  }

  /** Every day from `from` to `to`, both included. */
  static range(from: string, to: string): string[] {
    const days: string[] = [];
    for (let d = from; d <= to; d = UtcDays.add(d, 1)) days.push(d);
    return days;
  }

  static unix(date: string): number {
    return Math.floor(UtcDays.start(date).getTime() / 1000);
  }

  static isDate(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && UtcDays.of(UtcDays.start(value)) === value;
  }
}
