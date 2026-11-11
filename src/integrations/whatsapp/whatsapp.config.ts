import { z } from "zod";

import { ConfigSection, type ConfigValue } from "../../config/config-section.js";

const schema = z.object({
  // Eazotel's own WhatsApp Business number (Meta → WhatsApp → API setup). It sends renewal
  // reminders to hotels. Empty: reminders go by email only.
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  // a permanent System User token with whatsapp_business_messaging for that number
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  // Graph API version; Meta retires old ones about two years after release
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'must look like "v25.0"')
    .default("v25.0"),
});

export const whatsappConfig = new ConfigSection("whatsapp", schema);
export type WhatsappConfig = ConfigValue<typeof whatsappConfig>;
