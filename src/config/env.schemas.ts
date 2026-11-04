import { z } from "zod";

// Building blocks for env schemas. Every value in process.env is a string,
// so these parse the string into the type the code actually wants.

/** "a.com, b.com" → ["a.com", "b.com"] */
export const csv = z.string().transform((value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

/** true/false, 1/0, yes/no, on/off */
export const flag = z.stringbool();

export const port = z.coerce.number().int().min(1).max(65535);

export const positiveInt = z.coerce.number().int().positive();

export const nonNegativeInt = z.coerce.number().int().min(0);

/** "30s", "15m", "12h", "7d" (the format jose and our TTL helpers accept) */
export const duration = z.string().regex(/^\d+(ms|s|m|h|d)$/, 'must look like "30s", "15m", "12h" or "7d"');

export const mongoUri = z.string().regex(/^mongodb(\+srv)?:\/\//, "must be a mongodb:// or mongodb+srv:// URL");

export const redisUri = z.string().regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL");
