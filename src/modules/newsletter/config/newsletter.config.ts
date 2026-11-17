import { z } from "zod";

import { ConfigSection, type ConfigValue } from "../../../config/config-section.js";

const schema = z.object({
  // Signs the unsubscribe link in newsletter, welcome and campaign emails. Set the SAME value in
  // gian (its campaign sender adds the link). Empty: emails go out without an unsubscribe link.
  // Make one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  NEWSLETTER_UNSUBSCRIBE_SECRET: z.string().min(32).optional(),
});

export const newsletterConfig = new ConfigSection("newsletter", schema);
export type NewsletterConfig = ConfigValue<typeof newsletterConfig>;
