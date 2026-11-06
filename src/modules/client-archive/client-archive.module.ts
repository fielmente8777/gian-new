import type { AppModule } from "../../shared/module/app-module.js";
import { ClientArchiveRepository } from "./repositories/client-archive.repository.js";
import type { ClientArchivePort } from "./types/client-archive.types.js";

/**
 * Deleting a client: every record across the shared database, each copied to
 * deleted_client_records first (deleted_clients holds one summary per deletion).
 */
export class ClientArchiveModule implements AppModule {
  readonly name = "client-archive";
  private readonly repository = new ClientArchiveRepository();
  readonly port: ClientArchivePort = this.repository;

  /** The archive collections are new and small to index. */
  async init(): Promise<void> {
    await this.repository.ensureIndexes();
  }
}
