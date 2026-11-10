import mongoose, { Types } from "mongoose";

import type {
  PageConnectionDocumentView,
  PageConnectionStore,
  PageLink,
  StoredPage,
} from "../types/meta-pages.types.js";

/** gian's PageConnection.model.ts: one document per sign-in with Meta, keyed by the client that started it. */
interface PageConnectionDocument {
  _id: Types.ObjectId;
  ndid: string;
  hid: string;
  account_id?: string;
  account_name?: string;
  account_email?: string;
  longLivedToken?: string;
  isSynced?: boolean;
  pages?: StoredPage[];
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * pageconnections, the raw collection. gian owns its schema: it writes it when a hotel signs
 * in with Meta, and its lead webhook reads `pages[].ndid/hid` to know whose lead it is. Here
 * staff only set those two fields and refresh the pages; nothing else is touched.
 */
export class PageConnectionsRepository implements PageConnectionStore {
  private get collection() {
    return mongoose.connection.collection<PageConnectionDocument>("pageconnections");
  }

  async all(): Promise<PageConnectionDocumentView[]> {
    // _id order is the natural order gian's findOne reads in
    const docs = await this.collection.find({}).sort({ _id: 1 }).toArray();
    return docs.map(PageConnectionsRepository.toView);
  }

  async findById(connectionId: string): Promise<PageConnectionDocumentView | null> {
    if (!Types.ObjectId.isValid(connectionId)) return null;
    const doc = await this.collection.findOne({ _id: new Types.ObjectId(connectionId) });
    return doc ? PageConnectionsRepository.toView(doc) : null;
  }

  async setLink(pageId: string, link: PageLink | null): Promise<number> {
    const $set = link
      ? { "pages.$[p].ndid": link.ndid, "pages.$[p].hid": link.hid }
      : { "pages.$[p].ndid": null, "pages.$[p].hid": null };
    const result = await this.collection.updateMany(
      { "pages.id": pageId },
      { $set, $currentDate: { updatedAt: true } },
      { arrayFilters: [{ "p.id": pageId }] },
    );
    return result.matchedCount;
  }

  async savePages(connectionId: string, pages: StoredPage[]): Promise<void> {
    await this.collection.updateOne(
      { _id: new Types.ObjectId(connectionId) },
      { $set: { pages: pages.map(PageConnectionsRepository.withSubdocumentId) }, $currentDate: { updatedAt: true } },
    );
  }

  /** Mongoose gives every page subdocument an _id; new ones written here get one too. */
  private static withSubdocumentId(page: StoredPage): StoredPage {
    return page._id ? page : { ...page, _id: new Types.ObjectId() };
  }

  private static toView(doc: PageConnectionDocument): PageConnectionDocumentView {
    return {
      id: doc._id.toHexString(),
      ndid: doc.ndid,
      hid: String(doc.hid),
      accountId: doc.account_id ?? null,
      accountName: doc.account_name ?? null,
      accountEmail: doc.account_email ?? null,
      longLivedToken: doc.longLivedToken ?? null,
      updatedAt: doc.updatedAt ?? null,
      pages: Array.isArray(doc.pages) ? doc.pages.filter((p) => p && typeof p.id === "string") : [],
    };
  }
}
