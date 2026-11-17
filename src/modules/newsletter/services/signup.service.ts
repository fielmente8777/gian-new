import type { Mailer } from "../../../integrations/mail/mailer.js";
import type { Logger } from "../../../shared/logger/logger.js";
import { InvalidEmailError, UnknownWebsiteError } from "../errors/newsletter.errors.js";
import type { HotelDirectory, HotelInfo, SettingsStore, SubscriberStore } from "../types/newsletter.types.js";
import { DEFAULT_SETTINGS, Emails } from "./newsletter-defaults.js";
import type { UnsubscribeLinks } from "./unsubscribe-links.js";

export type SignupOutcome = "subscribed" | "already_subscribed" | "resubscribed";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The public side of the newsletter: the box on the hotel's website, and the unsubscribe link
 * at the bottom of every newsletter and campaign email.
 *
 * Signing up again after unsubscribing is allowed here (the person asked for it themselves).
 * Emails (welcome, "new subscriber" alert) never fail the signup: they are logged and dropped.
 */
export class SignupService {
  constructor(
    private readonly subscribers: SubscriberStore,
    private readonly settings: SettingsStore,
    private readonly hotels: HotelDirectory,
    private readonly mailer: Mailer,
    /** null when NEWSLETTER_UNSUBSCRIBE_SECRET is not set: emails then go out without the link */
    private readonly links: UnsubscribeLinks | null,
    private readonly logger: Logger,
    /** false while the hotel's subscription has ended or is paused: signups are kept, no emails go out */
    private readonly serving: (ndid: string) => Promise<boolean>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The website box. `site` is the website's domain (what nexon's /editnewsletter received). */
  async subscribe(input: { site: string; email: string; name?: string | null }): Promise<SignupOutcome> {
    const email = Emails.normalize(input.email ?? "");
    if (!Emails.isValid(email)) throw new InvalidEmailError();
    const hotel = await this.hotels.byDomain(input.site);
    if (!hotel) throw new UnknownWebsiteError();
    const { ndid } = hotel;

    const existing = await this.subscribers.byEmail(ndid, email);
    let outcome: SignupOutcome;
    if (existing?.status === "subscribed") {
      outcome = "already_subscribed";
    } else if (existing) {
      await this.subscribers.setStatus(ndid, [existing.id], "subscribed", null, this.now());
      await this.subscribers.update(ndid, existing.id, { source: existing.source === "campaign" ? "website" : existing.source }, this.now());
      outcome = "resubscribed";
    } else {
      await this.subscribers.insert(ndid, { email, name: input.name?.trim() || null, source: "website" }, this.now());
      outcome = "subscribed";
    }

    if (outcome !== "already_subscribed") {
      // after the answer is decided; a slow mail server must not hold up the website
      void this.afterSignup(hotel, email, input.name?.trim() || null);
    }
    return outcome;
  }

  /** For the confirmation page: who the link is for, without changing anything. */
  async preview(token: string | undefined): Promise<{ email: string; hotelName: string | null; alreadyOut: boolean } | null> {
    const target = this.links?.verify(token);
    if (!target) return null;
    const [hotel, row] = await Promise.all([
      this.hotels.byNdid(target.ndid),
      this.subscribers.byEmail(target.ndid, target.email),
    ]);
    return { email: target.email, hotelName: hotel?.hotelName ?? null, alreadyOut: row?.status === "unsubscribed" };
  }

  /**
   * Unsubscribes the address in the token. Someone who got a campaign without being on the list is
   * added as unsubscribed, so no newsletter or campaign reaches them again.
   */
  async unsubscribe(token: string | undefined, reason?: string | null): Promise<{ email: string; hotelName: string | null } | null> {
    const target = this.links?.verify(token);
    if (!target) return null;
    const { ndid, email } = target;
    const now = this.now();
    const row = await this.subscribers.byEmail(ndid, email);
    if (!row) {
      const created = await this.subscribers.insert(ndid, { email, source: "campaign", status: "unsubscribed" }, now);
      if (reason) await this.subscribers.update(ndid, created.id, { unsubscribeReason: reason.slice(0, 300) }, now);
    } else if (row.status !== "unsubscribed") {
      await this.subscribers.setStatus(ndid, [row.id], "unsubscribed", "subscriber", now);
      await this.subscribers.update(ndid, row.id, { unsubscribeReason: reason?.slice(0, 300) || null }, now);
    } else if (row.unsubscribedBy !== "subscriber") {
      // the hotel had unsubscribed them; now they asked too, so the hotel can't undo it
      await this.subscribers.update(ndid, row.id, { unsubscribedBy: "subscriber", unsubscribeReason: reason?.slice(0, 300) || row.unsubscribeReason }, now);
    }
    const hotel = await this.hotels.byNdid(ndid);
    return { email, hotelName: hotel?.hotelName ?? null };
  }

  private async afterSignup(hotel: HotelInfo, email: string, name: string | null): Promise<void> {
    if (!(await this.serving(hotel.ndid).catch(() => true))) return;
    const settings = (await this.settings.get(hotel.ndid).catch(() => null)) ?? DEFAULT_SETTINGS;
    const hotelName = hotel.hotelName || "our hotel";

    if (settings.welcome.enabled) {
      const fill = (text: string) => text.replace(/\{\{\s*name\s*\}\}/gi, name || "there").replace(/\{\{\s*hotel\s*\}\}/gi, hotelName);
      const message = fill(settings.welcome.message);
      const unsubscribe = this.links?.url(hotel.ndid, email);
      const paragraphs = message
        .split(/\n{2,}/)
        .map((p) => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
        .join("");
      const footer = unsubscribe
        ? `<p style="margin:24px 0 0;font-size:12px;color:#888">You're getting this because you subscribed on ${escapeHtml(hotelName)}'s website. <a href="${unsubscribe}" style="color:#888">Unsubscribe</a></p>`
        : "";
      await this.mailer
        .send({
          to: email,
          subject: fill(settings.welcome.subject),
          text: unsubscribe ? `${message}\n\n--\nUnsubscribe: ${unsubscribe}` : message,
          html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">${paragraphs}${footer}</div>`,
        })
        .catch((error: unknown) => this.logger.warn({ err: error, ndid: hotel.ndid }, "newsletter welcome email failed"));
    }

    if (settings.notifyOnSignup) {
      for (const to of hotel.alertEmails) {
        await this.mailer
          .send({
            to,
            subject: `New newsletter subscriber: ${email}`,
            text: `${name ? `${name} (${email})` : email} just subscribed to your newsletter on your website.\n\nSee your list in the Eazotel dashboard → Marketing → Newsletter.`,
          })
          .catch((error: unknown) => this.logger.warn({ err: error, ndid: hotel.ndid }, "newsletter signup alert failed"));
      }
    }
  }
}
