/** How many records of one collection belong to a client. */
export interface CollectionCount {
  collection: string;
  count: number;
}

export interface DeletionPreview {
  ndid: string;
  /** collections with at least one record, most records first */
  collections: CollectionCount[];
  total: number;
}

export interface DeletionResult extends DeletionPreview {
  /** finds the archived copies in deleted_client_records */
  deletionId: string;
}

export interface DeletionMeta {
  hotelName: string | null;
  /** email of the staff member */
  by: string;
  reason: string | null;
}

/**
 * Finds every record of a client across the shared database and deletes them, keeping a copy
 * of each in deleted_client_records first, so a mistake can be undone.
 */
export interface ClientArchivePort {
  preview(ndid: string): Promise<DeletionPreview>;
  archiveAndDelete(ndid: string, meta: DeletionMeta): Promise<DeletionResult>;
}

// ─── trash (temporary delete) ──────────────────────────────────────────────────────────

/** A client in the admin console's trash: hidden from every list, nothing deleted. */
export interface TrashedClient {
  ndid: string;
  hotelName: string | null;
  /** email of the staff member who moved it */
  by: string;
  reason: string | null;
  trashedAt: Date;
  /** true when moving it paused a running subscription, so restoring resumes it */
  pausedSubscription: boolean;
}

/**
 * The trash (client_trash). Moving a client there hides it from the admin console's lists and
 * pauses its subscription (done by the caller); its data stays exactly where it is, so a
 * restore brings everything back. Permanent delete is archiveAndDelete.
 */
export interface ClientTrashPort {
  /** false when it was already in the trash */
  add(client: TrashedClient): Promise<boolean>;
  /** the entry that was removed, or null when it was not in the trash */
  remove(ndid: string): Promise<TrashedClient | null>;
  find(ndid: string): Promise<TrashedClient | null>;
  list(): Promise<TrashedClient[]>;
  /** every ndid in the trash, for the lists to leave out */
  ndids(): Promise<string[]>;
}
