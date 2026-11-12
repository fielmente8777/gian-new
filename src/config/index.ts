import { mailConfig } from "../integrations/mail/mail.config.js";
import { razorpayConfig } from "../integrations/razorpay/razorpay.config.js";
import { whatsappConfig } from "../integrations/whatsapp/whatsapp.config.js";
import { zohoConfig } from "../integrations/zoho/zoho.config.js";
import { openAiAdminConfig } from "../integrations/openai/openai-admin.config.js";
import { adminConfig } from "../modules/admin/config/admin.config.js";
import { clientServicesConfig } from "../modules/client-services/config/client-services.config.js";
import { authConfig } from "../modules/auth/config/auth.config.js";
import { appConfig } from "./app.config.js";
import type { ConfigOf, EnvSource } from "./config-section.js";
import { databaseConfig } from "./database.config.js";
import { Env } from "./env.js";
import { redisConfig } from "./redis.config.js";

/**
 * Every config section, in the same order as container.ts builds things and as the
 * sections of .env.example. Add a module's section here when the module lands.
 */
export const configSections = {
  app: appConfig,
  database: databaseConfig,
  redis: redisConfig,
  mail: mailConfig,
  razorpay: razorpayConfig,
  whatsapp: whatsappConfig,
  zoho: zohoConfig,
  openai: openAiAdminConfig,
  auth: authConfig,
  admin: adminConfig,
  clientServices: clientServicesConfig,
} as const;

export type Config = ConfigOf<typeof configSections>;

/** Loads .env (if present) and validates everything. Throws EnvValidationError listing every problem. */
export function loadConfig(source?: EnvSource): Config {
  if (!source) Env.loadFile();
  return Env.validate(configSections, source ?? process.env);
}

export { EnvValidationError } from "./env-validation.error.js";
export type { AppConfig } from "./app.config.js";
export type { DatabaseConfig } from "./database.config.js";
export type { RedisConfig } from "./redis.config.js";
