import type { Transporter } from "nodemailer";

import type { Logger } from "../../shared/logger/logger.js";
import type { MailConfig } from "./mail.config.js";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
}

/** What modules depend on, so they never know how an email is really sent. */
export interface Mailer {
  /** false when emails only go to the logs (development), so nothing that must reach a person is "sent" */
  readonly delivers: boolean;
  send(message: MailMessage): Promise<void>;
}

/** Sends through an SMTP server over TLS. */
export class SmtpMailer implements Mailer {
  readonly delivers = true;
  private transporter?: Transporter;

  constructor(private readonly config: MailConfig) {}

  async send(message: MailMessage): Promise<void> {
    const transporter = await this.getTransporter();
    await transporter.sendMail({ from: this.config.MAIL_FROM, ...message });
  }

  /** Loaded on first use, so a machine that only prints emails to the logs never needs nodemailer. */
  private async getTransporter(): Promise<Transporter> {
    if (this.transporter) return this.transporter;
    const { default: nodemailer } = await import("nodemailer");
    const { MAIL_SMTP_HOST, MAIL_SMTP_PORT, MAIL_SMTP_USER, MAIL_SMTP_PASSWORD } = this.config;
    this.transporter = nodemailer.createTransport({
      host: MAIL_SMTP_HOST,
      port: MAIL_SMTP_PORT,
      secure: MAIL_SMTP_PORT === 465,
      requireTLS: MAIL_SMTP_PORT !== 465,
      ...(MAIL_SMTP_USER ? { auth: { user: MAIL_SMTP_USER, pass: MAIL_SMTP_PASSWORD } } : {}),
      tls: { minVersion: "TLSv1.2" },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    return this.transporter;
  }
}

/** Local development only: prints the email to the logs instead of sending it. */
export class DevLogMailer implements Mailer {
  readonly delivers = false;

  constructor(private readonly logger: Logger) {}

  async send({ to, subject, text, attachments }: MailMessage): Promise<void> {
    const files = attachments?.map((a) => `${a.filename} (${a.content.length} bytes)`);
    this.logger.warn({ to, subject, ...(files?.length ? { attachments: files } : {}) }, `DEV EMAIL, NOT SENT:\n${text}`);
  }
}

export class MailerFactory {
  /** Outside development a missing mail server stops the app at boot, never at the first login. */
  static create(config: MailConfig, appEnv: string, logger: Logger): Mailer {
    if (config.MAIL_SMTP_HOST) return new SmtpMailer(config);
    if (appEnv !== "development") throw new Error("MAIL_SMTP_HOST is required when APP_ENV is not development");
    logger.warn("MAIL_SMTP_HOST is empty: emails, including login codes, are printed to the logs");
    return new DevLogMailer(logger);
  }
}
