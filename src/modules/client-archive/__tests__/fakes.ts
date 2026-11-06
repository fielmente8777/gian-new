import type { ClientArchivePort, DeletionMeta } from "../types/client-archive.types.js";

/** In-memory client data: records per collection per client. */
export class InMemoryClientArchive implements ClientArchivePort {
  /** ndid → collection → count */
  readonly data = new Map<string, Record<string, number>>();
  readonly deleted: { ndid: string; meta: DeletionMeta }[] = [];

  async preview(ndid: string) {
    const collections = Object.entries(this.data.get(ndid) ?? {})
      .filter(([, count]) => count > 0)
      .map(([collection, count]) => ({ collection, count }))
      .sort((a, b) => b.count - a.count);
    return { ndid, collections, total: collections.reduce((s, c) => s + c.count, 0) };
  }

  async archiveAndDelete(ndid: string, meta: DeletionMeta) {
    const preview = await this.preview(ndid);
    this.data.delete(ndid);
    this.deleted.push({ ndid, meta });
    return { ...preview, deletionId: `del-${this.deleted.length}` };
  }
}
