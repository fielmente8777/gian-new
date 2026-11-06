import type { EventBus } from "../../../shared/events/event-bus.js";
import {
  GoogleLoginDisabledError,
  InvalidGoogleTokenError,
  type ClientInfo,
  type GoogleIdentity,
  type GoogleIdentityVerifier,
} from "../../auth/index.js";
import { AdminNotAllowedError, OtpExpiredError } from "../errors/admin.errors.js";
import "../events/admin.events.js";
import type { AdminRecord, AdminUserStore } from "../types/admin.types.js";
import type { AdminOtpService, StartedChallenge } from "./admin-otp.service.js";

export interface PendingLogin extends StartedChallenge {
  email: string;
}

/**
 * Admin login, two steps:
 *  1. Google proves who the person is. The email must already be in admin_users, and nothing
 *     is ever created for an unknown one.
 *  2. A code emailed to that address proves they still have the mailbox.
 * Only after step 2 does a session exist.
 */
export class AdminAuthService {
  constructor(
    private readonly admins: AdminUserStore,
    private readonly google: GoogleIdentityVerifier | null,
    private readonly otp: AdminOtpService,
    private readonly events: EventBus,
  ) {}

  async startLogin(idToken: string, client: ClientInfo): Promise<PendingLogin> {
    const identity = await this.verifyGoogle(idToken);
    const admin = await this.admins.findByEmail(identity.email);
    this.assertAllowed(admin, identity, client);

    const challenge = await this.otp.start(admin, identity.sub);
    this.events.emit("admin.login_code_sent", { adminId: admin.id, email: admin.email, ip: client.ip });
    return { ...challenge, email: AdminAuthService.maskEmail(admin.email) };
  }

  async resendCode(challengeId: string): Promise<PendingLogin> {
    const challenge = await this.otp.getActive(challengeId);
    const admin = await this.admins.findById(challenge.adminId);
    if (!admin || admin.status !== "active") throw new AdminNotAllowedError();

    const next = await this.otp.resend(challengeId, admin.email);
    return { ...next, email: AdminAuthService.maskEmail(admin.email) };
  }

  async completeLogin(challengeId: string, code: string, client: ClientInfo): Promise<AdminRecord> {
    const { adminId, googleSub } = await this.otp.verify(challengeId, code);
    // access may have been taken away while the code was on its way
    const admin = await this.admins.findById(adminId);
    if (!admin) throw new OtpExpiredError();
    if (admin.status !== "active") throw new AdminNotAllowedError();

    const now = new Date();
    await this.admins.recordLogin(admin.id, googleSub, now);
    this.events.emit("admin.logged_in", { adminId: admin.id, email: admin.email, ip: client.ip });
    return { ...admin, googleId: googleSub, lastLoginAt: now };
  }

  private async verifyGoogle(idToken: string): Promise<GoogleIdentity> {
    if (!this.google) throw new GoogleLoginDisabledError();
    let identity: GoogleIdentity;
    try {
      identity = await this.google.verify(idToken);
    } catch {
      throw new InvalidGoogleTokenError();
    }
    if (!identity.emailVerified) throw new InvalidGoogleTokenError();
    return identity;
  }

  /** A linked admin must keep using the same Google account, even if the email is reissued to someone else. */
  private assertAllowed(
    admin: AdminRecord | null,
    identity: GoogleIdentity,
    client: ClientInfo,
  ): asserts admin is AdminRecord {
    const reason = !admin
      ? "not_listed"
      : admin.status !== "active"
        ? "disabled"
        : admin.googleId && admin.googleId !== identity.sub
          ? "google_mismatch"
          : null;
    if (!reason) return;
    this.events.emit("admin.login_denied", { email: identity.email, reason, ip: client.ip });
    throw new AdminNotAllowedError();
  }

  /** "sarah@eazotel.com" → "sa***@eazotel.com" */
  static maskEmail(email: string): string {
    const [name = "", domain = ""] = email.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
}
