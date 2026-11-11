import { z } from "zod";

import { ConfigSection, type ConfigValue } from "../../config/config-section.js";

const schema = z.object({
  // A "Server-based application" client from https://api-console.zoho.in (Zoho's India data
  // centre). Its redirect URI must be <PUBLIC_URL>/api/v1/billing/zoho/callback.
  // Empty: the admin console's Zoho Books card says it isn't set up, and Razorpay stays the only way to pay.
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),
  // accounts.zoho.in / www.zohoapis.in for India; .com for the US data centre, .eu for Europe
  ZOHO_ACCOUNTS_URL: z.url().default("https://accounts.zoho.in"),
  ZOHO_API_URL: z.url().default("https://www.zohoapis.in"),
  // 32 random bytes, base64: encrypts the saved Zoho refresh token. Generate one with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ZOHO_TOKEN_KEY: z
    .string()
    .optional()
    .refine((v) => !v || Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64"),
  // a long random value; Zoho's workflow webhook sends it as ?token=, nothing else is trusted
  ZOHO_WEBHOOK_TOKEN: z.string().min(24, "use at least 24 random characters").optional(),
});

export const zohoConfig = new ConfigSection("zoho", schema);
export type ZohoConfig = ConfigValue<typeof zohoConfig>;
