const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const REASONS = [
  "I get too many emails",
  "The emails aren't relevant to me",
  "I never signed up",
  "Other",
];

/**
 * The pages a guest sees after clicking "Unsubscribe" in an email. Plain HTML, no scripts,
 * light and dark. The link only shows a confirm button (GET): mail scanners open every link in an
 * email, so a GET must never unsubscribe anyone. The button POSTs.
 */
export class UnsubscribePage {
  static confirm(input: { token: string; email: string; hotelName: string | null; alreadyOut: boolean }): string {
    const from = input.hotelName ? escapeHtml(input.hotelName) : "this hotel";
    if (input.alreadyOut) {
      return UnsubscribePage.layout(
        "You're unsubscribed",
        `<p><strong>${escapeHtml(input.email)}</strong> is already unsubscribed from ${from}'s emails. Nothing else to do.</p>`,
      );
    }
    const reasons = REASONS.map(
      (r) => `<label class="reason"><input type="radio" name="reason" value="${escapeHtml(r)}"> ${escapeHtml(r)}</label>`,
    ).join("");
    return UnsubscribePage.layout(
      "Unsubscribe?",
      `<p>Stop emails from <strong>${from}</strong> to <strong>${escapeHtml(input.email)}</strong>?</p>
       <form method="post" action="?t=${encodeURIComponent(input.token)}">
         <fieldset><legend>Tell us why (optional)</legend>${reasons}</fieldset>
         <button type="submit">Unsubscribe</button>
       </form>`,
    );
  }

  static done(email: string, hotelName: string | null): string {
    const from = hotelName ? escapeHtml(hotelName) : "this hotel";
    return UnsubscribePage.layout(
      "You're unsubscribed",
      `<p><strong>${escapeHtml(email)}</strong> won't get newsletters or offers from ${from} any more.</p>
       <p class="muted">Changed your mind? Sign up again with the newsletter box on ${from}'s website.</p>`,
    );
  }

  static invalid(): string {
    return UnsubscribePage.layout(
      "This link doesn't work",
      `<p>The unsubscribe link is incomplete or has been changed. Please use the link from the email again, or reply to the email and ask to be removed.</p>`,
    );
  }

  private static layout(title: string, body: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e4e4e0;--accent:#ea580c}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1c1c1a;--text:#f1f1ee;--muted:#a3a39d;--line:#2e2e2b}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:22px;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:14px}
fieldset{border:0;padding:0;margin:16px 0}legend{font-size:14px;color:var(--muted);margin-bottom:8px}
.reason{display:flex;gap:8px;align-items:center;padding:6px 0;font-size:15px}
button{width:100%;border:0;border-radius:10px;padding:12px 16px;background:var(--accent);color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer}
button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  }
}
