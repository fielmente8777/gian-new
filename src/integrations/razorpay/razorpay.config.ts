import { z } from "zod";

import { ConfigSection, type ConfigValue } from "../../config/config-section.js";

const schema = z.object({
  // Razorpay API keys of Eazotel's own account (Dashboard → Account & Settings → API keys).
  // rzp_test_… keys for testing. Empty: billing answers 503 BILLING_NOT_CONFIGURED.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  // Secret typed when the webhook was added in Razorpay (Account & Settings → Webhooks).
  // Empty: the webhook answers 503 and payments are confirmed only by the browser.
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

export const razorpayConfig = new ConfigSection("razorpay", schema);
export type RazorpayConfig = ConfigValue<typeof razorpayConfig>;
