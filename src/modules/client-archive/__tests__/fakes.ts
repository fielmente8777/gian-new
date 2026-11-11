import type { ClientArchivePort, ClientTrashPort, DeletionMeta, TrashedClient } from "../types/client-archive.types.js";

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

/** In-memory trash. */
export class InMemoryClientTrash implements ClientTrashPort {
  readonly rows = new Map<string, TrashedClient>();

  async add(client: TrashedClient) {
    if (this.rows.has(client.ndid)) return false;
    this.rows.set(client.ndid, { ...client });
    return true;
  }

  async remove(ndid: string) {
    const row = this.rows.get(ndid) ?? null;
    this.rows.delete(ndid);
    return row;
  }

  async find(ndid: string) {
    return this.rows.get(ndid) ?? null;
  }

  async list() {
    return [...this.rows.values()].sort((a, b) => b.trashedAt.getTime() - a.trashedAt.getTime());
  }

  async ndids() {
    return [...this.rows.keys()];
  }
}
