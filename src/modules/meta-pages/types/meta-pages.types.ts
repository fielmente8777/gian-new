import type { GraphPage, MetaGraph } from "../../../integrations/meta/meta-graph.client.js";

export type { GraphPage, MetaGraph };

/** The client property a Meta page belongs to: its leads are saved under this ndid and hid. */
export interface PageLink {
  ndid: string;
  hid: string;
}

/** One sign-in with Meta (one pageconnections document) and what it says about a page. */
export interface PageInConnection {
  connectionId: string;
  /** who signed in with Meta (the Facebook account's name) */
  accountName: string | null;
  /** the client account that started that sign-in */
  owner: PageLink;
  /** the client this connection's copy of the page is linked to */
  link: PageLink | null;
  hasToken: boolean;
}

/**
 * A Facebook page, merged over every sign-in that returned it. The same page shows up in
 * several pageconnections documents when several people (or the agency) signed in with Meta.
 */
export interface MetaPageRecord {
  pageId: string;
  name: string | null;
  category: string | null;
  pictureUrl: string | null;
  instagram: { username: string | null; followers: number | null } | null;
  /**
   * Where new leads from this page go: the first linked copy, which is the one gian's lead
   * webhook picks. Null means leads from this page are dropped.
   */
  link: PageLink | null;
  /** true when copies are linked to different clients */
  conflict: boolean;
  connections: PageInConnection[];
}

/** A pageconnections document, without its tokens. */
export interface MetaConnectionRecord {
  connectionId: string;
  owner: PageLink;
  accountId: string | null;
  accountName: string | null;
  accountEmail: string | null;
  pageCount: number;
  linkedCount: number;
  hasToken: boolean;
  syncedAt: Date | null;
}

/** What one refresh from Meta changed in a connection. */
export interface SyncResult {
  connectionId: string;
  /** pages Meta returned */
  returned: number;
  added: string[];
  updated: number;
  /** pages still in the document that Meta no longer returns: kept, links untouched */
  missing: string[];
  /** new pages that could not be subscribed to lead webhooks */
  subscribeFailed: { pageId: string; reason: string }[];
}

/** What the admin module may do with Meta pages. */
export interface MetaPagesPort {
  listPages(): Promise<MetaPageRecord[]>;
  findPage(pageId: string): Promise<MetaPageRecord | null>;
  listConnections(): Promise<MetaConnectionRecord[]>;
  /**
   * Links (or with null, unlinks) the page in every connection that has it, so the lead
   * webhook finds the same client whichever copy it reads. Null when no connection has it.
   */
  setLink(pageId: string, link: PageLink | null): Promise<MetaPageRecord | null>;
  /** Fetches the connection's pages from Meta again. Null when there is no such connection. */
  sync(connectionId: string): Promise<SyncResult | null>;
}

/** The raw store under MetaPagesPort, faked in tests. */
export interface PageConnectionStore {
  /** every document, oldest first, tokens included (never leaves the module) */
  all(): Promise<PageConnectionDocumentView[]>;
  findById(connectionId: string): Promise<PageConnectionDocumentView | null>;
  /** sets or clears ndid/hid on the page in every document; returns how many documents had it */
  setLink(pageId: string, link: PageLink | null): Promise<number>;
  /** writes the merged pages array of one document */
  savePages(connectionId: string, pages: StoredPage[]): Promise<void>;
}

/** One entry of pageconnections.pages, as gian stores it. */
export interface StoredPage {
  id: string;
  name?: string;
  access_token?: string;
  category?: string;
  picture?: unknown;
  ndid?: string | null;
  hid?: string | null;
  instagram_business_account?: {
    ig_id?: string;
    user_name?: string;
    profile_picture_url?: string;
    followers_count?: number;
  };
  [key: string]: unknown;
}

export interface PageConnectionDocumentView {
  id: string;
  ndid: string;
  hid: string;
  accountId: string | null;
  accountName: string | null;
  accountEmail: string | null;
  longLivedToken: string | null;
  updatedAt: Date | null;
  pages: StoredPage[];
}
