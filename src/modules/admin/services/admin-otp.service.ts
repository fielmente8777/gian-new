import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import type { Mailer } from "../../../integrations/mail/mailer.js";
import type { AdminConfig } from "../config/admin.config.js";
import {
  OtpAttemptsExceededError,
  OtpExpiredError,
  OtpInvalidError,
  OtpResendUnavailableError,
  OtpSendFailedError,
} from "../errors/admin.errors.js";
import type { AdminRecord, OtpChallengeStore } from "../types/admin.types.js";

const CODE_DIGITS = 6;

export interface StartedChallenge {
  id: string;
  expiresAt: Date;
  resendAfterSeconds: number;
}

export interface VerifiedChallenge {
  adminId: string;
  googleSub: string;
}

/**
 * The email code step of admin login.
 * - Codes are random, single use and short lived, and only their hash is stored.
 * - Wrong attempts are counted per login and never reset, so asking for a new code does not
 *   give more guesses. After the limit the login must start again from Google.
 */
export class AdminOtpService {
  constructor(
    private readonly store: OtpChallengeStore,
    private readonly mailer: Mailer,
    private readonly config: AdminConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(admin: AdminRecord, googleSub: string): Promise<StartedChallenge> {
    const id = randomUUID();
    const code = this.generateCode();
    const now = this.now();
    const expiresAt = this.expiryFrom(now);
    await this.store.create({
      id,
      adminId: admin.id,
      googleSub,
      codeHash: this.hash(id, code),
      lastSentAt: now,
      expiresAt,
    });
    try {
      await this.sendCode(admin.email, code);
    } catch (error) {
      await this.store.delete(id);
      throw new OtpSendFailedError(error);
    }
    return { id, expiresAt, resendAfterSeconds: this.config.ADMIN_OTP_RESEND_SECONDS };
  }

  /** A new code replaces the old one, which stops working straight away. */
  async resend(id: string, email: string): Promise<StartedChallenge> {
    const code = this.generateCode();
    const now = this.now();
    const expiresAt = this.expiryFrom(now);
    const sentBefore = new Date(now.getTime() - this.config.ADMIN_OTP_RESEND_SECONDS * 1000);
    const replaced = await this.store.replaceCode(
      id,
      { codeHash: this.hash(id, code), lastSentAt: now, expiresAt },
      sentBefore,
      this.config.ADMIN_OTP_MAX_SENDS,
    );
    if (!replaced) throw new OtpResendUnavailableError();
    try {
      await this.sendCode(email, code);
    } catch (error) {
      throw new OtpSendFailedError(error);
    }
    return { id, expiresAt, resendAfterSeconds: this.config.ADMIN_OTP_RESEND_SECONDS };
  }

  /** The challenge a browser is holding, while it is still usable. */
  async getActive(id: string) {
    const challenge = await this.store.find(id);
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= this.now()) throw new OtpExpiredError();
    return challenge;
  }

  async verify(id: string, code: string): Promise<VerifiedChallenge> {
    const challenge = await this.getActive(id);
    const maxAttempts = this.config.ADMIN_OTP_MAX_ATTEMPTS;
    if (!(await this.store.recordAttempt(id, maxAttempts))) throw new OtpAttemptsExceededError();

    if (!this.matches(this.hash(id, code), challenge.codeHash)) {
      const attemptsLeft = maxAttempts - challenge.attempts - 1;
      if (attemptsLeft <= 0) throw new OtpAttemptsExceededError();
      throw new OtpInvalidError(attemptsLeft);
    }
    if (!(await this.store.consume(id, this.now()))) throw new OtpExpiredError();
    return { adminId: challenge.adminId, googleSub: challenge.googleSub };
  }

  private generateCode(): string {
    return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
  }

  private expiryFrom(now: Date): Date {
    return new Date(now.getTime() + this.config.ADMIN_OTP_TTL_SECONDS * 1000);
  }

  /** Salted with the challenge id, so the same code never gives the same hash twice. */
  private hash(id: string, code: string): string {
    return createHash("sha256").update(`${id}:${code}`).digest("base64url");
  }

  private matches(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private sendCode(to: string, code: string): Promise<void> {
    const minutes = Math.round(this.config.ADMIN_OTP_TTL_SECONDS / 60);
    return this.mailer.send({
      to,
      subject: `${code} is your Eazotel Admin sign-in code`,
      text: [
        `Your Eazotel Admin sign-in code is ${code}.`,
        "",
        `It expires in ${minutes} minutes and works once. Nobody at Eazotel will ask you for it.`,
        "If you did not try to sign in, tell a super admin, because someone may be using your Google account.",
      ].join("\n"),
      html: `<p>Your Eazotel Admin sign-in code is:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>
<p>It expires in ${minutes} minutes and works once. Nobody at Eazotel will ask you for it.</p>
<p>If you did not try to sign in, tell a super admin, because someone may be using your Google account.</p>`,
    });
  }
}
