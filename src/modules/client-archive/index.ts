// Public API of the client-archive module. Other modules import from here only.
export { ClientArchiveModule } from "./client-archive.module.js";
export type {
  ClientArchivePort,
  CollectionCount,
  DeletionMeta,
  DeletionPreview,
  DeletionResult,
} from "./types/client-archive.types.js";
