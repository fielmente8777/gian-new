import type { GraphPage, MetaGraph } from "../../../integrations/meta/meta-graph.client.js";
import { MetaPagesService } from "../services/meta-pages.service.js";
import type {
  MetaPagesPort,
  PageConnectionDocumentView,
  PageConnectionStore,
  PageLink,
  StoredPage,
} from "../types/meta-pages.types.js";

/** In-memory pageconnections, with the same "link every copy" rule as the repository. */
export class InMemoryPageConnections implements PageConnectionStore {
  readonly docs: PageConnectionDocumentView[] = [];
  private nextId = 1;

  add(doc: Partial<PageConnectionDocumentView> & { ndid: string; hid: string; pages: StoredPage[] }): string {
    const id = (this.nextId++).toString(16).padStart(24, "0");
    this.docs.push({
      id,
      accountId: "meta-user",
      accountName: "Agency Person",
      accountEmail: null,
      longLivedToken: "user-token",
      updatedAt: null,
      ...doc,
    });
    return id;
  }

  async all() {
    return structuredClone(this.docs);
  }

  async findById(id: string) {
    const doc = this.docs.find((d) => d.id === id);
    return doc ? structuredClone(doc) : null;
  }

  async setLink(pageId: string, link: PageLink | null) {
    let matched = 0;
    for (const doc of this.docs) {
      const pages = doc.pages.filter((p) => p.id === pageId);
      if (pages.length) matched++;
      for (const page of pages) {
        page.ndid = link?.ndid ?? null;
        page.hid = link?.hid ?? null;
      }
    }
    return matched;
  }

  async savePages(id: string, pages: StoredPage[]) {
    const doc = this.docs.find((d) => d.id === id);
    if (doc) doc.pages = structuredClone(pages);
  }
}

/** Meta's Graph API with pages set by the test. */
export class FakeMetaGraph implements MetaGraph {
  pagesByToken = new Map<string, GraphPage[]>();
  subscribed: string[] = [];
  failSubscribe = new Set<string>();

  async pages(userToken: string) {
    return this.pagesByToken.get(userToken) ?? [];
  }

  async subscribeLeadgen(pageId: string) {
    if (this.failSubscribe.has(pageId)) return { ok: false as const, reason: "no permission" };
    this.subscribed.push(pageId);
    return { ok: true as const };
  }
}

export class TestMetaPages {
  static create(): { store: InMemoryPageConnections; graph: FakeMetaGraph; port: MetaPagesPort } {
    const store = new InMemoryPageConnections();
    const graph = new FakeMetaGraph();
    return { store, graph, port: new MetaPagesService(store, graph) };
  }
}
