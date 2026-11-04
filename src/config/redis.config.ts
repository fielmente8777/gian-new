import { z } from "zod";

import { ConfigSection, type ConfigValue } from "./config-section.js";
import { redisUri } from "./env.schemas.js";

const schema = z.object({
  REDIS_URL: redisUri,
  // prefix for cache keys and BullMQ queues, so one Redis can serve several apps
  REDIS_KEY_PREFIX: z.string().min(1).default("gian"),
});

export const redisConfig = new ConfigSection("redis", schema);
export type RedisConfig = ConfigValue<typeof redisConfig>;
