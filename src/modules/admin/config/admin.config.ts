import { z } from "zod";

import { ConfigSection, type ConfigValue } from "../../../config/config-section.js";
import { csv, duration, positiveInt } from "../../../config/env.schemas.js";

const schema = z.object({
  // `aud` of admin tokens. Different from AUTH_JWT_AUDIENCE, so a hotel token never works on
  // the admin API and an admin token never works on the hotel API.
  ADMIN_JWT_AUDIENCE: z.string().min(1).default("eazotel-admin"),
  ADMIN_ACCESS_TTL: duration.default("15m"),
  // days a staff login lasts WITHOUT being used: every visit moves it forward again (sliding),
  // so someone who uses the console stays signed in until they log out
  ADMIN_REFRESH_TTL_DAYS: positiveInt.default(30),
  // a separate cookie, so the hotel dashboard and admin console sessions never mix
  ADMIN_REFRESH_COOKIE_NAME: z.string().min(1).default("ez_admin_rt"),
  // "lax" when the console and the API share a site (admin.eazotel.com + gn.eazotel.com).
  // "none" when they don't (admin.eazotel.com + gian-new.onrender.com): browsers never send a
  // lax cookie to another site, so every reload and every token renewal would sign staff out.
  // "none" is always sent with Secure. Browsers that block third-party cookies (Safari, Brave,
  // incognito) still drop it, so a same-site API domain is the real fix.
  ADMIN_COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
  ADMIN_OTP_TTL_SECONDS: positiveInt.default(300),
  // wrong codes allowed before the login must start again from Google
  ADMIN_OTP_MAX_ATTEMPTS: positiveInt.default(5),
  ADMIN_OTP_RESEND_SECONDS: positiveInt.default(60),
  // emails per login attempt, counting the first one
  ADMIN_OTP_MAX_SENDS: positiveInt.default(4),
  // the admin console's address, the sign-in link in team invite emails
  ADMIN_CONSOLE_URL: z.url().default("https://admin.eazotel.com"),
  // an account whose holder logs in with an email on these domains is a test dashboard (the console's Test tab)
  ADMIN_TEST_EMAIL_DOMAINS: csv.default(["eazotel.com", "fielmente.com"]),
});

export const adminConfig = new ConfigSection("admin", schema);
export type AdminConfig = ConfigValue<typeof adminConfig>;
