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
