import { z } from "zod";

import { ConfigSection, type ConfigValue } from "../../../config/config-section.js";
import { flag, nonNegativeInt } from "../../../config/env.schemas.js";

const schema = z.object({
  // true (default): a subscription whose end date has passed (or that was cancelled) stops the
  // chatbot and every lead alert (email, WhatsApp, in-app, push), like a staff expiry; renewing
  // brings them back with one catch-up email. false: only subscriptions staff paused or expired
  // do. Keep the same value in gian.
  CLIENT_SERVICES_FOLLOW_EXPIRY: flag.default(true),
  // how often to apply changes made outside the admin console (a hotel paying in gian, a
  // subscription running out). 0 turns the sweep off.
  CLIENT_SERVICES_SWEEP_SECONDS: nonNegativeInt.default(60),
});

export const clientServicesConfig = new ConfigSection("clientServices", schema);
export type ClientServicesConfig = ConfigValue<typeof clientServicesConfig>;
