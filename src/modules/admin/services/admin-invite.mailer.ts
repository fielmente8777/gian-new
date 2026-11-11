import type { Mailer } from "../../../integrations/mail/mailer.js";
import type { Logger } from "../../../shared/logger/logger.js";
import type { AdminRecord } from "../types/admin.types.js";

const ROLE_LABEL: Record<AdminRecord["role"], string> = { super_admin: "super admin", admin: "admin" };

/**
 * The email a new staff member gets when a super admin adds them: the console's link and how
 * to sign in (Google with this exact address, then the emailed code). It holds no password or
 * token, so a forwarded invite gives nobody else access.
 */
export class AdminInviteMailer {
  constructor(
    private readonly mailer: Mailer,
    private readonly consoleUrl: string,
    private readonly logger: Logger,
  ) {}

  /** true when sent. A failed email never undoes the add: the super admin can resend it. */
  async send(member: AdminRecord, invitedBy: AdminRecord): Promise<boolean> {
    const link = `${this.consoleUrl.replace(/\/+$/, "")}/login`;
    const by = invitedBy.name ? `${invitedBy.name} (${invitedBy.email})` : invitedBy.email;
    const text = [
      `Hello${member.name ? ` ${member.name}` : ""},`,
      "",
      `${by} added you to the Eazotel admin console as ${ROLE_LABEL[member.role]}.`,
      "",
      `Sign in here: ${link}`,
      "",
      "How to sign in:",
      `1. Open the link and choose "Sign in with Google".`,
      `2. Pick the Google account for ${member.email}. Any other account is refused.`,
      "3. We email you a 6-digit code. Type it in, and you are in.",
      "",
      "You will need a new code each time you sign in on a new device.",
      "If you did not expect this email, ignore it: nobody can use it to sign in as you.",
      "",
      "Team Eazotel",
    ].join("\n");
    try {
      if (!this.mailer.delivers)
        this.logger.warn({ to: member.email }, "team invite only printed to the logs (no mail server)");
      await this.mailer.send({ to: member.email, subject: "You're invited to the Eazotel admin console", text });
      return this.mailer.delivers;
    } catch (err) {
      this.logger.warn({ err, to: member.email }, "team invite email failed");
      return false;
    }
  }
}
