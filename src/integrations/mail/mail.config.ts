import { z } from "zod";

import { ConfigSection, type ConfigValue } from "../../config/config-section.js";
import { port } from "../../config/env.schemas.js";

const schema = z.object({
  // SMTP server, e.g. email-smtp.ap-south-1.amazonaws.com. Empty: in development emails are
  // printed to the logs instead of sent; on any other APP_ENV the app refuses to start.
  MAIL_SMTP_HOST: z.string().optional(),
  MAIL_SMTP_PORT: port.default(587),
  MAIL_SMTP_USER: z.string().optional(),
  MAIL_SMTP_PASSWORD: z.string().optional(),
  // sender shown to the recipient; the address must be verified with the mail provider
  MAIL_FROM: z.string().default("Eazotel <no-reply@eazotel.com>"),
});

export const mailConfig = new ConfigSection("mail", schema);
export type MailConfig = ConfigValue<typeof mailConfig>;
