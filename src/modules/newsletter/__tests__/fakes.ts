import { pino } from "pino";

import type { Mailer, MailMessage } from "../../../integrations/mail/mailer.js";
import type {
  HotelDirectory,
  HotelInfo,
  NewSubscriber,
  NewsletterSettings,
  NewsletterStats,
  SettingsStore,
  Subscriber,
  SubscriberFilter,
  SubscriberSource,
  SubscriberStatus,
  SubscriberStore,
  UnsubscribedBy,
} from "../types/newsletter.types.js";

export const silentLogger = pino({ level: "silent" });

/** In-memory `Newsletters`, with the same rules as SubscriberRepository (missing status = subscribed). */
export class InMemorySubscribers implements SubscriberStore {
  readonly rows: Subscriber[] = [];
  private nextId = 1;

  private matches(s: Subscriber, ndid: string, f: SubscriberFilter): boolean {
    if (s.ndid !== ndid) return false;
    if (f.status && s.status !== f.status) return false;
    if (f.source && s.source !== f.source) return false;
    if (f.tag && !s.tags.includes(f.tag)) return false;
    if (f.search) {
      const q = f.search.toLowerCase();
      if (!s.email.includes(q) && !(s.name ?? "").toLowerCase().includes(q)) return false;
    }
    return true;
  }

  async list(ndid: string, filter: SubscriberFilter, page: number, limit: number) {
    const all = await this.all(ndid, filter);
    return { items: all.slice((page - 1) * limit, page * limit), total: all.length, page, limit };
  }

  async all(ndid: string, filter: SubscriberFilter) {
    return this.rows
      .filter((s) => this.matches(s, ndid, filter))
      .sort((a, b) => b.subscribedAt.getTime() - a.subscribedAt.getTime());
  }

  async byId(ndid: string, id: string) {
    return this.rows.find((s) => s.ndid === ndid && s.id === id) ?? null;
  }

  async byEmail(ndid: string, email: string) {
    return this.rows.find((s) => s.ndid === ndid && s.email.toLowerCase() === email.toLowerCase()) ?? null;
  }

  async byEmails(ndid: string, emails: string[]) {
    return this.rows.filter((s) => s.ndid === ndid && emails.includes(s.email));
  }

  async insert(ndid: string, input: NewSubscriber & { source: SubscriberSource; status?: SubscriberStatus }, now: Date) {
    const status = input.status ?? "subscribed";
    const row: Subscriber = {
      id: String(this.nextId++).padStart(24, "0"),
      ndid,
      email: input.email.toLowerCase(),
      name: input.name ?? null,
      status,
      source: input.source,
      tags: input.tags ?? [],
      subscribedAt: now,
      unsubscribedAt: status === "unsubscribed" ? now : null,
      unsubscribedBy: status === "unsubscribed" ? "subscriber" : null,
      unsubscribeReason: null,
      updatedAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  async update(ndid: string, id: string, changes: Partial<Subscriber>, now: Date) {
    const row = this.rows.find((s) => s.ndid === ndid && s.id === id);
    if (!row) return null;
    Object.assign(row, changes, { updatedAt: now });
    return { ...row };
  }

  async merge(ndid: string, rows: { email: string; name: string | null; tags: string[] }[], source: SubscriberSource, now: Date) {
    let added = 0;
    let updated = 0;
    for (const r of rows) {
      const existing = this.rows.find((s) => s.ndid === ndid && s.email === r.email);
      if (existing) {
        updated += 1;
        if (r.name) existing.name = r.name;
        existing.tags = [...new Set([...existing.tags, ...r.tags])];
      } else {
        added += 1;
        await this.insert(ndid, { email: r.email, name: r.name, tags: r.tags, source }, now);
      }
    }
    return { added, updated };
  }

  async setStatus(ndid: string, ids: string[], status: SubscriberStatus, by: UnsubscribedBy | null, now: Date) {
    let n = 0;
    for (const row of this.rows.filter((s) => s.ndid === ndid && ids.includes(s.id) && s.status !== status)) {
      row.status = status;
      row.unsubscribedAt = status === "unsubscribed" ? now : null;
      row.unsubscribedBy = status === "unsubscribed" ? (by ?? "hotel") : null;
      if (status === "subscribed") row.unsubscribeReason = null;
      n += 1;
    }
    return n;
  }

  async addTags(ndid: string, ids: string[], tags: string[]) {
    const rows = this.rows.filter((s) => s.ndid === ndid && ids.includes(s.id));
    for (const row of rows) row.tags = [...new Set([...row.tags, ...tags])];
    return rows.length;
  }

  async removeTags(ndid: string, ids: string[], tags: string[]) {
    const rows = this.rows.filter((s) => s.ndid === ndid && ids.includes(s.id));
    for (const row of rows) row.tags = row.tags.filter((t) => !tags.includes(t));
    return rows.length;
  }

  async remove(ndid: string, ids: string[]) {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i]!.ndid === ndid && ids.includes(this.rows[i]!.id)) this.rows.splice(i, 1);
    }
    return before - this.rows.length;
  }

  async tags(ndid: string) {
    return [...new Set(this.rows.filter((s) => s.ndid === ndid).flatMap((s) => s.tags))].sort();
  }

  async stats(ndid: string): Promise<NewsletterStats> {
    const mine = this.rows.filter((s) => s.ndid === ndid);
    const unsubscribed = mine.filter((s) => s.status === "unsubscribed").length;
    return {
      total: mine.length,
      subscribed: mine.length - unsubscribed,
      unsubscribed,
      newLast30Days: 0,
      unsubscribedLast30Days: 0,
      months: [],
      bySource: {},
    };
  }
}

export class InMemorySettings implements SettingsStore {
  readonly rows = new Map<string, NewsletterSettings>();

  async get(ndid: string) {
    return this.rows.get(ndid) ?? null;
  }

  async save(ndid: string, settings: Omit<NewsletterSettings, "updatedAt">, now: Date) {
    const saved = { ...settings, updatedAt: now };
    this.rows.set(ndid, saved);
    return saved;
  }
}

export class FakeHotels implements HotelDirectory {
  constructor(private readonly hotels: (HotelInfo & { domain: string })[]) {}

  async byDomain(domain: string) {
    const bare = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    return this.hotels.find((h) => h.domain === bare) ?? null;
  }

  async byNdid(ndid: string) {
    return this.hotels.find((h) => h.ndid === ndid) ?? null;
  }
}

export class RecordingMailer implements Mailer {
  readonly delivers = true;
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}
