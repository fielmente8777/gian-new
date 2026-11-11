import type { AppModule } from "../../shared/module/app-module.js";
import { ClientArchiveRepository } from "./repositories/client-archive.repository.js";
import { ClientTrashRepository } from "./repositories/client-trash.repository.js";
import type { ClientArchivePort, ClientTrashPort } from "./types/client-archive.types.js";

/**
 * Deleting a client: every record across the shared database, each copied to
 * deleted_client_records first (deleted_clients holds one summary per deletion).
 * Also the trash (client_trash): a temporary delete that only hides the client.
 */
export class ClientArchiveModule implements AppModule {
  readonly name = "client-archive";
  private readonly repository = new ClientArchiveRepository();
  private readonly trashRepository = new ClientTrashRepository();
  readonly port: ClientArchivePort = this.repository;
  readonly trash: ClientTrashPort = this.trashRepository;

  /** The archive collections are new and small to index. */
  async init(): Promise<void> {
    await this.repository.ensureIndexes();
    await this.trashRepository.ensureIndexes();
  }
}
