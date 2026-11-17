import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed unsubscribe links. The token names the client (ndid) and the address, so the link
 * works without a login and can't be edited to unsubscribe someone else.
 *
 *   token = base64url(JSON [ndid, email]) + "." + base64url(HMAC-SHA256(secret, that first part))[0..22]
 *
 * gian's campaign sender builds the same tokens (gian/src/utils/newsletterUnsubscribe.ts) with the
 * same NEWSLETTER_UNSUBSCRIBE_SECRET; change both together.
 */
export class UnsubscribeLinks {
  private static readonly SIGNATURE_LENGTH = 22;

  constructor(
    private readonly secret: string,
    /** this API's public URL, e.g. https://gn.eazotel.com */
    private readonly publicUrl: string,
  ) {}

  token(ndid: string, email: string): string {
    const payload = Buffer.from(JSON.stringify([ndid, email.toLowerCase()])).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  url(ndid: string, email: string): string {
    return `${this.publicUrl.replace(/\/+$/, "")}/newsletter/unsubscribe?t=${this.token(ndid, email)}`;
  }

  /** The client and address the token was made for, or null when it was changed or is malformed. */
  verify(token: string | undefined | null): { ndid: string; email: string } | null {
    if (!token || token.length > 1000) return null;
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (!Array.isArray(value) || typeof value[0] !== "string" || typeof value[1] !== "string") return null;
      return { ndid: value[0], email: value[1] };
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url")
      .slice(0, UnsubscribeLinks.SIGNATURE_LENGTH);
  }
}
