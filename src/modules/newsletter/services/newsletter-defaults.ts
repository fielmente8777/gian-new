import type { NewsletterSettings } from "../types/newsletter.types.js";

/** Email checks and clean-up shared by the dashboard and the website box. */
export class Emails {
  // deliberately loose: one @, a dot in the domain, no spaces or brackets
  private static readonly PATTERN = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;

  static normalize(email: string): string {
    return email.trim().toLowerCase();
  }

  static isValid(email: string): boolean {
    return email.length <= 254 && Emails.PATTERN.test(email);
  }
}

/** Tags are short labels, compared as typed but trimmed and without repeats. */
export class Tags {
  static clean(tags: readonly string[] | undefined): string[] {
    return [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 20);
  }
}

/** What a client has before it saves its own settings. */
export const DEFAULT_SETTINGS: Omit<NewsletterSettings, "updatedAt"> = {
  welcome: {
    enabled: false,
    subject: "Thanks for subscribing to {{hotel}}",
    message:
      "Hi {{name}},\n\nThank you for joining the {{hotel}} newsletter. We'll write now and then with our latest offers, " +
      "packages and news.\n\nWe look forward to welcoming you.\n\nWarm regards,\nTeam {{hotel}}",
  },
  notifyOnSignup: false,
};
