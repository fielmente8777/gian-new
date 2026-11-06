import type { MailMessage } from "../../../integrations/mail/mailer.js";
import type { PendingLeadAlert } from "../types/client-services.types.js";

/** Leads listed in the email; the rest are counted and are in the dashboard. */
const MAX_ROWS = 50;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

/**
 * The one email a hotel gets when its services come back: every lead that came in while they
 * were stopped, instead of one alert per lead (which would arrive as a burst of dozens).
 */
export class LeadDigest {
  static render(hotelName: string | null, alerts: PendingLeadAlert[]): Omit<MailMessage, "to"> {
    const count = alerts.length;
    const noun = count === 1 ? "lead" : "leads";
    const shown = alerts.slice(0, MAX_ROWS);
    const more = count - shown.length;
    const name = hotelName ?? "your hotel";

    const lines = shown.map((a) =>
      [when.format(a.receivedAt), a.name ?? "-", a.phone ?? "-", a.email ?? "-", a.source ?? "-"].join(" | "),
    );
    const text = [
      `Hello ${name},`,
      "",
      `Your Eazotel services are active again. ${count} new ${noun} came in while they were paused:`,
      "",
      ...lines,
      ...(more > 0 ? ["", `…and ${more} more. All of them are in your Eazotel dashboard now.`] : []),
      "",
      "Follow up soon: the earliest ones have been waiting.",
      "",
      "Eazotel",
    ].join("\n");

    const cell = (v: string | null) =>
      `<td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(v ?? "-")}</td>`;
    const rows = shown
      .map((a) => `<tr>${[when.format(a.receivedAt), a.name, a.phone, a.email, a.source].map(cell).join("")}</tr>`)
      .join("");
    const html = `<div style="font-family:Arial,sans-serif;color:#152547">
<p>Hello ${escapeHtml(name)},</p>
<p>Your Eazotel services are active again. <strong>${count} new ${noun}</strong> came in while they were paused:</p>
<table style="border-collapse:collapse;font-size:14px"><thead><tr>${["Received", "Name", "Phone", "Email", "Source"]
      .map((h) => `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #fc5f07">${h}</th>`)
      .join("")}</tr></thead><tbody>${rows}</tbody></table>
${more > 0 ? `<p>…and ${more} more. All of them are in your Eazotel dashboard now.</p>` : "<p>All of them are in your Eazotel dashboard now.</p>"}
<p>Follow up soon: the earliest ones have been waiting.</p>
<p>Eazotel</p></div>`;

    return { subject: `${count} new ${noun} for ${name} while your services were paused`, text, html };
  }
}
