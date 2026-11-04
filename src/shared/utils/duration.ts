const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Converts the duration strings used in config ("30s", "15m", "12h", "7d") to numbers. */
export class Duration {
  static toMs(value: string): number {
    const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
    if (!match) throw new Error(`Invalid duration "${value}"`);
    return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  }

  static toSeconds(value: string): number {
    return Math.floor(Duration.toMs(value) / 1000);
  }
}
