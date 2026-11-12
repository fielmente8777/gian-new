/**
 * Where a lead came from, as gian names it in hotelnotifications.config:
 * - webform: the hotel's website forms (WordPress, Webflow, Eazotel websites);
 * - eazbot: the chatbot;
 * - whatsapp: a guest writing to the hotel on WhatsApp;
 * - facebook: Meta (Facebook / Instagram) lead ads;
 * - google: Google Ads lead forms.
 */
export const LEAD_SOURCES = ["webform", "eazbot", "whatsapp", "facebook", "google"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/** How one property hears about leads from one source. */
export interface SourceAlerts {
  /** a "New lead" email to the hotel's email plus `emails` */
  email: boolean;
  emails: string[];
  /** a WhatsApp message to the hotel's phone plus `phones` */
  whatsapp: boolean;
  phones: string[];
}

export type SourceAlertsMap = Record<LeadSource, SourceAlerts>;

/** One property's alert settings (one hotelnotifications document). */
export interface PropertyAlerts {
  hid: string;
  /** false: nothing saved yet, so gian's defaults apply (see DEFAULT_ALERTS) */
  saved: boolean;
  sources: SourceAlertsMap;
}

/**
 * What gian does for a property that never saved settings: every alert on, email to the
 * hotel's email and WhatsApp to the hotel's phone. gian only skips an alert whose switch
 * (isEmailAllowed / isPhoneAllowed) is saved false (since 2026-11-09 for email).
 */
export const DEFAULT_ALERTS: Readonly<SourceAlerts> = { email: true, emails: [], whatsapp: true, phones: [] };

/** The hotelnotifications collection, shared with gian and the hotel dashboard. */
export interface HotelNotificationsPort {
  /** One entry per hid asked for, in that order; unsaved ones carry the defaults. */
  list(ndid: string, hids: string[]): Promise<PropertyAlerts[]>;
  /**
   * Saves every source of one property, creating its document if needed. Leaves everything
   * else in the document (callConfig) as it was.
   */
  save(ndid: string, hid: string, sources: SourceAlertsMap): Promise<PropertyAlerts>;
  /**
   * Adds one WhatsApp number, written exactly as given, to every source of a property that
   * doesn't already have it (compared as digits). Switches, emails and other numbers stay as
   * they are; a property with no document gets one holding only these numbers (alerts stay on
   * by default). Returns the sources it was added to.
   */
  addPhone(ndid: string, hid: string, phone: string): Promise<LeadSource[]>;
}

export class SourceAlertsDefaults {
  /** a fresh copy of the defaults for every source */
  static all(): SourceAlertsMap {
    return Object.fromEntries(
      LEAD_SOURCES.map((s) => [s, { ...DEFAULT_ALERTS, emails: [], phones: [] }]),
    ) as unknown as SourceAlertsMap;
  }
}
