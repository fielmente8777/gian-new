import { MetaGraphError } from "../../../integrations/meta/meta-graph.client.js";
import { MetaSyncFailedError, MetaTokenMissingError } from "../errors/meta-pages.errors.js";
import type {
  GraphPage,
  MetaConnectionRecord,
  MetaGraph,
  MetaPageRecord,
  MetaPagesPort,
  PageConnectionDocumentView,
  PageConnectionStore,
  PageInConnection,
  PageLink,
  StoredPage,
  SyncResult,
} from "../types/meta-pages.types.js";

/** Lead webhooks are subscribed a few pages at a time, not 30 requests at once. */
const SUBSCRIBE_CONCURRENCY = 5;

/**
 * Facebook pages across every sign-in with Meta. gian's lead webhook finds a lead's client
 * from `pages[].ndid/hid`, so linking a page here decides whose dashboard its leads reach.
 *
 * A page often sits in several pageconnections documents (the agency account and the hotel
 * both signed in), so a link is always written to every copy of the page.
 */
export class MetaPagesService implements MetaPagesPort {
  constructor(
    private readonly store: PageConnectionStore,
    private readonly graph: MetaGraph,
  ) {}

  async listPages(): Promise<MetaPageRecord[]> {
    const pages = MetaPagesService.merge(await this.store.all());
    return pages.sort((a, b) => (a.name ?? a.pageId).localeCompare(b.name ?? b.pageId));
  }

  async findPage(pageId: string): Promise<MetaPageRecord | null> {
    return MetaPagesService.merge(await this.store.all()).find((p) => p.pageId === pageId) ?? null;
  }

  async listConnections(): Promise<MetaConnectionRecord[]> {
    return (await this.store.all()).map((doc) => ({
      connectionId: doc.id,
      owner: { ndid: doc.ndid, hid: doc.hid },
      accountId: doc.accountId,
      accountName: doc.accountName,
      accountEmail: doc.accountEmail,
      pageCount: doc.pages.length,
      linkedCount: doc.pages.filter((p) => MetaPagesService.linkOf(p)).length,
      hasToken: Boolean(doc.longLivedToken),
      syncedAt: doc.updatedAt,
    }));
  }

  async setLink(pageId: string, link: PageLink | null): Promise<MetaPageRecord | null> {
    const matched = await this.store.setLink(pageId, link);
    return matched === 0 ? null : this.findPage(pageId);
  }

  async sync(connectionId: string): Promise<SyncResult | null> {
    const doc = await this.store.findById(connectionId);
    if (!doc) return null;
    if (!doc.longLivedToken) throw new MetaTokenMissingError();

    const fromMeta = await this.graph.pages(doc.longLivedToken).catch((err: unknown) => {
      throw err instanceof MetaGraphError ? new MetaSyncFailedError(err.message) : err;
    });
    // a new copy of a page already linked elsewhere gets the same link, or its leads could be dropped
    const links = new Map(
      MetaPagesService.merge(await this.store.all())
        .filter((p) => p.link)
        .map((p) => [p.pageId, p.link as PageLink]),
    );

    const existing = new Map(doc.pages.map((p) => [p.id, p]));
    const added: string[] = [];
    let updated = 0;
    const merged: StoredPage[] = doc.pages.map((page) => {
      const fresh = fromMeta.find((g) => g.id === page.id);
      if (!fresh) return page;
      updated++;
      return { ...page, ...MetaPagesService.fromGraph(fresh, page) };
    });
    for (const fresh of fromMeta) {
      if (existing.has(fresh.id)) continue;
      added.push(fresh.id);
      const link = links.get(fresh.id);
      merged.push({ ...MetaPagesService.fromGraph(fresh, null), ndid: link?.ndid ?? null, hid: link?.hid ?? null });
    }
    await this.store.savePages(connectionId, merged);

    const returned = new Set(fromMeta.map((p) => p.id));
    return {
      connectionId,
      returned: fromMeta.length,
      added,
      updated,
      missing: doc.pages.filter((p) => !returned.has(p.id)).map((p) => p.id),
      subscribeFailed: await this.subscribeAll(fromMeta),
    };
  }

  /** Same as gian after a sign-in: every page Meta returned gets lead webhooks (Meta ignores repeats). */
  private async subscribeAll(pages: GraphPage[]): Promise<{ pageId: string; reason: string }[]> {
    const failed: { pageId: string; reason: string }[] = [];
    for (let i = 0; i < pages.length; i += SUBSCRIBE_CONCURRENCY) {
      const batch = pages.slice(i, i + SUBSCRIBE_CONCURRENCY);
      const results = await Promise.all(batch.map((p) => this.graph.subscribeLeadgen(p.id, p.accessToken)));
      results.forEach((r, j) => {
        if (!r.ok) failed.push({ pageId: batch[j]!.id, reason: r.reason });
      });
    }
    return failed;
  }

  /** The fields Meta owns, in gian's stored shape; the link and anything else stay as they were. */
  private static fromGraph(page: GraphPage, before: StoredPage | null): StoredPage {
    return {
      id: page.id,
      name: page.name,
      access_token: page.accessToken,
      ...(page.category ? { category: page.category } : {}),
      ...(page.picture ? { picture: page.picture } : {}),
      ...(page.instagram
        ? {
            instagram_business_account: {
              ig_id: page.instagram.igId,
              ...(page.instagram.username ? { user_name: page.instagram.username } : {}),
              ...(page.instagram.pictureUrl ? { profile_picture_url: page.instagram.pictureUrl } : {}),
              ...(page.instagram.followers !== null ? { followers_count: page.instagram.followers } : {}),
            },
          }
        : before?.instagram_business_account
          ? { instagram_business_account: before.instagram_business_account }
          : {}),
    };
  }

  /** One record per page id, from documents in _id order (the order gian's findOne reads). */
  static merge(docs: PageConnectionDocumentView[]): MetaPageRecord[] {
    const byId = new Map<string, MetaPageRecord>();
    for (const doc of docs) {
      for (const page of doc.pages) {
        let record = byId.get(page.id);
        if (!record) {
          record = {
            pageId: page.id,
            name: null,
            category: null,
            pictureUrl: null,
            instagram: null,
            link: null,
            conflict: false,
            connections: [],
          };
          byId.set(page.id, record);
        }
        // the newest sign-in has the freshest name and picture
        record.name = MetaPagesService.text(page.name) ?? record.name;
        record.category = MetaPagesService.text(page.category) ?? record.category;
        record.pictureUrl = MetaPagesService.pictureUrl(page.picture) ?? record.pictureUrl;
        const ig = page.instagram_business_account;
        if (ig?.ig_id) record.instagram = { username: ig.user_name ?? null, followers: ig.followers_count ?? null };

        const link = MetaPagesService.linkOf(page);
        const copy: PageInConnection = {
          connectionId: doc.id,
          accountName: doc.accountName,
          owner: { ndid: doc.ndid, hid: doc.hid },
          link,
          hasToken: Boolean(page.access_token),
        };
        record.connections.push(copy);
        if (link && !record.link) record.link = link;
        else if (link && record.link && !MetaPagesService.same(link, record.link)) record.conflict = true;
      }
    }
    return [...byId.values()];
  }

  private static linkOf(page: StoredPage): PageLink | null {
    const ndid = MetaPagesService.text(page.ndid);
    const hid = page.hid === undefined || page.hid === null ? null : MetaPagesService.text(String(page.hid));
    return ndid && hid ? { ndid, hid } : null;
  }

  private static same(a: PageLink, b: PageLink): boolean {
    return a.ndid === b.ndid && a.hid === b.hid;
  }

  private static text(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  }

  /** Meta's picture field is { data: { url } }. */
  private static pictureUrl(picture: unknown): string | null {
    const url = (picture as { data?: { url?: unknown } } | null | undefined)?.data?.url;
    return typeof url === "string" ? url : null;
  }
}
