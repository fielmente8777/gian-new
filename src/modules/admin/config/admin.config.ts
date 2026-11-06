import { z } from "zod";

import { ConfigSection, type ConfigValue } from "../../../config/config-section.js";
import { duration, positiveInt } from "../../../config/env.schemas.js";

const schema = z.object({
  // `aud` of admin tokens. Different from AUTH_JWT_AUDIENCE, so a hotel token never works on
  // the admin API and an admin token never works on the hotel API.
  ADMIN_JWT_AUDIENCE: z.string().min(1).default("eazotel-admin"),
  ADMIN_ACCESS_TTL: duration.default("15m"),
  // how long a staff member stays signed in before Google + email code are needed again
  ADMIN_REFRESH_TTL_DAYS: positiveInt.default(7),
  // a separate cookie, so the hotel dashboard and admin console sessions never mix
  ADMIN_REFRESH_COOKIE_NAME: z.string().min(1).default("ez_admin_rt"),
  ADMIN_OTP_TTL_SECONDS: positiveInt.default(300),
  // wrong codes allowed before the login must start again from Google
  ADMIN_OTP_MAX_ATTEMPTS: positiveInt.default(5),
  ADMIN_OTP_RESEND_SECONDS: positiveInt.default(60),
  // emails per login attempt, counting the first one
  ADMIN_OTP_MAX_SENDS: positiveInt.default(4),
});

export const adminConfig = new ConfigSection("admin", schema);
export type AdminConfig = ConfigValue<typeof adminConfig>;
