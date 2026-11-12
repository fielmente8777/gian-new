/**
 * Phone numbers as Eazotel stores them: written in many ways ("+91 98765 43210",
 * "919876543210", "9876543210"). gian sends WhatsApp messages to the digits exactly as
 * stored (utils/normalizePhone.ts toPhoneDigits), adding no country code.
 */
export class PhoneNumbers {
  /**
   * Digits with the country code, or null when it can't be a phone number. "00" counts as
   * "+". A bare 10-digit number is taken as Indian (91 in front), the same rule as the admin
   * console's alert numbers; use hasCountryCode first when guessing is not acceptable.
   */
  static digits(value: unknown): string | null {
    if (typeof value !== "string" && typeof value !== "number") return null;
    let digits = String(value).replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.length === 10) digits = `91${digits}`;
    return /^[1-9]\d{10,14}$/.test(digits) ? digits : null;
  }

  /** Same number however it is written. */
  static same(a: unknown, b: unknown): boolean {
    const [x, y] = [PhoneNumbers.digits(a), PhoneNumbers.digits(b)];
    return x !== null && x === y;
  }

  /**
   * True only when the number clearly carries its country code: written with "+" or "00", or
   * 12 to 15 digits not starting with 0. "9876543210" and "09876543210" are not.
   */
  static hasCountryCode(value: unknown): boolean {
    if (typeof value !== "string" && typeof value !== "number") return false;
    const text = String(value).trim();
    const digits = text.replace(/\D/g, "");
    if (/^(\+|00)/.test(text)) return PhoneNumbers.digits(text) !== null && digits.replace(/^00/, "").length >= 11;
    return /^[1-9]\d{11,14}$/.test(digits);
  }

  /** "+919876543210": how onboarding writes the hotel phone and the team screen shows it. */
  static international(value: unknown): string | null {
    const digits = PhoneNumbers.digits(value);
    return digits ? `+${digits}` : null;
  }
}
