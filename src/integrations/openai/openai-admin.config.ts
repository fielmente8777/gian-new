import { z } from "zod";

import { ConfigSection, type ConfigValue } from "../../config/config-section.js";

/**
 * The OpenAI organization Admin key (sk-admin-…, made under Organization settings → Admin keys).
 * Only used to read costs for the admin console. Empty: the AI credits screens still work, but
 * the OpenAI pool, spend and reconciliation show "not configured".
 */
const schema = z.object({
  OPENAI_ADMIN_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export const openAiAdminConfig = new ConfigSection("openai", schema);
export type OpenAiAdminConfig = ConfigValue<typeof openAiAdminConfig>;
