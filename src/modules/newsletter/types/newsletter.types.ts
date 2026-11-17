export const SUBSCRIBER_STATUSES = ["subscribed", "unsubscribed"] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

/**
 * How the person got on the list.
 * - website: the newsletter box on the hotel's website (nexon's /editnewsletter, or /newsletter/subscribe)
 * - manual: added by hand in the dashboard
 * - import: a CSV / Excel file uploaded in the dashboard
 * - campaign: never subscribed, but unsubscribed from a campaign email (kept so they're never emailed again)
 */
export const SUBSCRIBER_SOURCES = ["website", "manual", "import", "campaign"] as const;
export type SubscriberSource = (typeof SUBSCRIBER_SOURCES)[number];

/** Who unsubscribed them. Only an unsubscribe made by the hotel can be undone from the dashboard. */
export type UnsubscribedBy = "subscriber" | "hotel";

export interface Subscriber {
  id: string;
  ndid: string;
  email: string;
  name: string | null;
  status: SubscriberStatus;
  source: SubscriberSource;
  tags: string[];
  subscribedAt: Date;
  unsubscribedAt: Date | null;
  unsubscribedBy: UnsubscribedBy | null;
  unsubscribeReason: string | null;
  updatedAt: Date;
}

export interface SubscriberFilter {
  status?: SubscriberStatus;
  source?: SubscriberSource;
  tag?: string;
  search?: string;
}

export interface SubscriberPage {
  items: Subscriber[];
  total: number;
  page: number;
  limit: number;
}

export interface NewSubscriber {
  email: string;
  name?: string | null;
  tags?: string[];
}

export interface ImportResult {
  /** new on the list */
  added: number;
  /** already on the list: name filled in and tags added */
  updated: number;
  /** unsubscribed earlier: left unsubscribed, a file never signs anyone up again */
  skippedUnsubscribed: number;
  invalid: number;
  duplicatesInFile: number;
}

export interface MonthCount {
  /** "2026-11" */
  month: string;
  subscribed: number;
  unsubscribed: number;
}

export interface NewsletterStats {
  total: number;
  subscribed: number;
  unsubscribed: number;
  /** signed up in the last 30 days (still subscribed) */
  newLast30Days: number;
  unsubscribedLast30Days: number;
  /** last 12 months, oldest first, months with nothing included */
  months: MonthCount[];
  bySource: Partial<Record<SubscriberSource, number>>;
}

export interface WelcomeEmail {
  enabled: boolean;
  subject: string;
  /** plain text; blank lines start new paragraphs; {{name}} and {{hotel}} are filled in */
  message: string;
}

export interface NewsletterSettings {
  welcome: WelcomeEmail;
  /** email the hotel when someone signs up on the website */
  notifyOnSignup: boolean;
  updatedAt: Date | null;
}

export type BulkAction = "delete" | "unsubscribe" | "resubscribe" | "addTags" | "removeTags";

export interface BulkResult {
  changed: number;
  /** resubscribe only: people who unsubscribed themselves stay unsubscribed */
  skipped: number;
}

/** `Newsletters` (shared with nexon, which inserts { ndid, email } from the website box). */
export interface SubscriberStore {
  list(ndid: string, filter: SubscriberFilter, page: number, limit: number): Promise<SubscriberPage>;
  /** every match, newest first, for the CSV export and the send list */
  all(ndid: string, filter: SubscriberFilter): Promise<Subscriber[]>;
  byId(ndid: string, id: string): Promise<Subscriber | null>;
  byEmail(ndid: string, email: string): Promise<Subscriber | null>;
  byEmails(ndid: string, emails: string[]): Promise<Subscriber[]>;
  insert(ndid: string, subscriber: NewSubscriber & { source: SubscriberSource; status?: SubscriberStatus }, now: Date): Promise<Subscriber>;
  update(ndid: string, id: string, changes: Partial<Omit<Subscriber, "id" | "ndid">>, now: Date): Promise<Subscriber | null>;
  /** upserts by email; returns how many were new and how many existed */
  merge(ndid: string, rows: { email: string; name: string | null; tags: string[] }[], source: SubscriberSource, now: Date): Promise<{ added: number; updated: number }>;
  setStatus(ndid: string, ids: string[], status: SubscriberStatus, by: UnsubscribedBy | null, now: Date): Promise<number>;
  addTags(ndid: string, ids: string[], tags: string[], now: Date): Promise<number>;
  removeTags(ndid: string, ids: string[], tags: string[], now: Date): Promise<number>;
  remove(ndid: string, ids: string[]): Promise<number>;
  tags(ndid: string): Promise<string[]>;
  stats(ndid: string, now: Date): Promise<NewsletterStats>;
}

/** `newsletter_settings`, one per client. Owned by this module. */
export interface SettingsStore {
  get(ndid: string): Promise<NewsletterSettings | null>;
  save(ndid: string, settings: Omit<NewsletterSettings, "updatedAt">, now: Date): Promise<NewsletterSettings>;
}

/** What the module needs to know about a hotel. */
export interface HotelInfo {
  ndid: string;
  hotelName: string | null;
  /** where the "someone signed up" email goes */
  alertEmails: string[];
}

export interface HotelDirectory {
  byDomain(domain: string): Promise<HotelInfo | null>;
  byNdid(ndid: string): Promise<HotelInfo | null>;
}
