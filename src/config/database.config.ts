import { z } from "zod";

import { ConfigSection, type ConfigValue } from "./config-section.js";
import { flag, mongoUri, positiveInt } from "./env.schemas.js";

const schema = z.object({
  MONGO_URI: mongoUri,
  // no default on purpose: always say which database you are pointing at
  MONGO_DB: z.string().min(1),
  // build indexes on startup; off by default because a local .env may point at a shared
  // cluster, where index builds must be run on purpose (scripts/sync-indexes)
  MONGO_AUTO_INDEX: flag.default(false),
  MONGO_MAX_POOL_SIZE: positiveInt.default(20),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: positiveInt.default(15_000),
});

export const databaseConfig = new ConfigSection("database", schema);
export type DatabaseConfig = ConfigValue<typeof databaseConfig>;
