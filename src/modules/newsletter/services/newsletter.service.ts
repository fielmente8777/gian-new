import { InvalidEmailError, SubscriberExistsError, SubscriberNotFoundError, SubscriberOptedOutError } from "../errors/newsletter.errors.js";
import type {
  BulkAction,
  BulkResult,
  ImportResult,
  NewSubscriber,
  NewsletterSettings,
  NewsletterStats,
  Subscriber,
  SubscriberFilter,
  SubscriberPage,
  SubscriberStatus,
  SubscriberStore,
  SettingsStore,
} from "../types/newsletter.types.js";
import { DEFAULT_SETTINGS, Emails, Tags } from "./newsletter-defaults.js";

/** Most rows one import may hold; the dashboard splits bigger files. */
export const IMPORT_LIMIT = 10_000;

/**
 * The hotel's newsletter list as the dashboard manages it: browse, add, import, tag,
 * unsubscribe, delete, export, and the addresses to send a newsletter to.
 *
 * One rule runs through it: someone who unsubscribed themselves is never signed up again by
 * the hotel (not by hand, not by an import, not by "resubscribe"). Only they can, from the website.
 */
export class NewsletterService {
  constructor(
    private readonly subscribers: SubscriberStore,
    private readonly settingsStore: SettingsStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(ndid: string, filter: SubscriberFilter, page: number, limit: number): Promise<SubscriberPage> {
    return this.subscribers.list(ndid, filter, page, limit);
  }

  stats(ndid: string): Promise<NewsletterStats> {
    return this.subscribers.stats(ndid, this.now());
  }

  tags(ndid: string): Promise<string[]> {
    return this.subscribers.tags(ndid);
  }

  async add(ndid: string, input: NewSubscriber): Promise<Subscriber> {
    const email = Emails.normalize(input.email);
    if (!Emails.isValid(email)) throw new InvalidEmailError();
    const existing = await this.subscribers.byEmail(ndid, email);
    if (existing?.status === "subscribed") throw new SubscriberExistsError();
    if (existing?.unsubscribedBy === "subscriber") throw new SubscriberOptedOutError();
    if (existing) {
      // the hotel had unsubscribed them: adding them again brings them back
      await this.subscribers.setStatus(ndid, [existing.id], "subscribed", null, this.now());
      return (await this.subscribers.update(
        ndid,
        existing.id,
        { name: input.name?.trim() || existing.name, tags: Tags.clean([...existing.tags, ...(input.tags ?? [])]) },
        this.now(),
      ))!;
    }
    return this.subscribers.insert(
      ndid,
      { email, name: input.name?.trim() || null, tags: Tags.clean(input.tags), source: "manual" },
      this.now(),
    );
  }

  async edit(
    ndid: string,
    id: string,
    changes: { name?: string | null; tags?: string[]; status?: SubscriberStatus },
  ): Promise<Subscriber> {
    const current = await this.subscribers.byId(ndid, id);
    if (!current) throw new SubscriberNotFoundError();
    if (changes.status && changes.status !== current.status) {
      if (changes.status === "subscribed" && current.unsubscribedBy === "subscriber") throw new SubscriberOptedOutError();
      await this.subscribers.setStatus(ndid, [id], changes.status, "hotel", this.now());
    }
    const fields: Partial<Subscriber> = {};
    if (changes.name !== undefined) fields.name = changes.name?.trim() || null;
    if (changes.tags !== undefined) fields.tags = Tags.clean(changes.tags);
    const updated = Object.keys(fields).length
      ? await this.subscribers.update(ndid, id, fields, this.now())
      : await this.subscribers.byId(ndid, id);
    return updated!;
  }

  async bulk(ndid: string, ids: string[], action: BulkAction, tags: string[] = []): Promise<BulkResult> {
    const now = this.now();
    switch (action) {
      case "delete":
        return { changed: await this.subscribers.remove(ndid, ids), skipped: 0 };
      case "unsubscribe":
        return { changed: await this.subscribers.setStatus(ndid, ids, "unsubscribed", "hotel", now), skipped: 0 };
      case "resubscribe": {
        const rows = (await Promise.all(ids.map((id) => this.subscribers.byId(ndid, id)))).filter(
          (s): s is Subscriber => s !== null,
        );
        const allowed = rows.filter((s) => s.unsubscribedBy !== "subscriber").map((s) => s.id);
        const changed = await this.subscribers.setStatus(ndid, allowed, "subscribed", null, now);
        return { changed, skipped: rows.length - allowed.length };
      }
      case "addTags":
        return { changed: await this.subscribers.addTags(ndid, ids, Tags.clean(tags), now), skipped: 0 };
      case "removeTags":
        return { changed: await this.subscribers.removeTags(ndid, ids, Tags.clean(tags), now), skipped: 0 };
    }
  }

  /** Rows from a CSV / Excel file the dashboard has read. Addresses that unsubscribed stay unsubscribed. */
  async import(
    ndid: string,
    rows: { email: string; name?: string | null }[],
    tags: string[] = [],
  ): Promise<ImportResult> {
    const extraTags = Tags.clean(tags);
    const seen = new Map<string, { email: string; name: string | null; tags: string[] }>();
    let invalid = 0;
    let duplicatesInFile = 0;
    for (const row of rows.slice(0, IMPORT_LIMIT)) {
      const email = Emails.normalize(row.email ?? "");
      if (!Emails.isValid(email)) {
        invalid += 1;
        continue;
      }
      if (seen.has(email)) {
        duplicatesInFile += 1;
        continue;
      }
      seen.set(email, { email, name: row.name?.trim() || null, tags: extraTags });
    }

    const existing = await this.subscribers.byEmails(ndid, [...seen.keys()]);
    const optedOut = new Set(existing.filter((s) => s.status === "unsubscribed").map((s) => s.email.toLowerCase()));
    const toMerge = [...seen.values()].filter((r) => !optedOut.has(r.email));
    const { added, updated } = await this.subscribers.merge(ndid, toMerge, "import", this.now());
    return { added, updated, skippedUnsubscribed: optedOut.size, invalid, duplicatesInFile };
  }

  /** Who a newsletter goes to: everyone subscribed, or only those with the tag. */
  async audience(ndid: string, tag?: string): Promise<string[]> {
    const rows = await this.subscribers.all(ndid, { status: "subscribed", ...(tag && { tag }) });
    return [...new Set(rows.map((s) => s.email.toLowerCase()))];
  }

  async exportCsv(ndid: string, filter: SubscriberFilter): Promise<string> {
    const rows = await this.subscribers.all(ndid, filter);
    const header = ["Email", "Name", "Status", "Source", "Tags", "Subscribed on", "Unsubscribed on"];
    const lines = rows.map((s) =>
      [
        s.email,
        s.name ?? "",
        s.status,
        s.source,
        s.tags.join("; "),
        s.subscribedAt.toISOString().slice(0, 10),
        s.unsubscribedAt ? s.unsubscribedAt.toISOString().slice(0, 10) : "",
      ]
        .map(NewsletterService.csvCell)
        .join(","),
    );
    // BOM so Excel opens the file as UTF-8 (names with accents, Hindi, ...)
    return `﻿${[header.join(","), ...lines].join("\r\n")}\r\n`;
  }

  async settings(ndid: string): Promise<NewsletterSettings> {
    return (await this.settingsStore.get(ndid)) ?? { ...DEFAULT_SETTINGS, updatedAt: null };
  }

  saveSettings(ndid: string, settings: Omit<NewsletterSettings, "updatedAt">): Promise<NewsletterSettings> {
    return this.settingsStore.save(ndid, settings, this.now());
  }

  /** Quotes a cell when it needs it, and stops spreadsheet formulas (=, +, -, @) from running. */
  private static csvCell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  }
}
