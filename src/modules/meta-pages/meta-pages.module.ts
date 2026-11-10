import { MetaGraphClient } from "../../integrations/meta/meta-graph.client.js";
import type { AppModule } from "../../shared/module/app-module.js";
import { PageConnectionsRepository } from "./repositories/page-connections.repository.js";
import { MetaPagesService } from "./services/meta-pages.service.js";
import type { MetaGraph, MetaPagesPort, PageConnectionStore } from "./types/meta-pages.types.js";

export interface MetaPagesModuleDeps {
  /** Tests replace the collection and Meta with fakes. */
  store?: PageConnectionStore;
  graph?: MetaGraph;
}

/**
 * Facebook pages from every sign-in with Meta (gian's pageconnections), and which client
 * each page's leads belong to. No routes of its own: staff reach it through the admin module.
 * See the README in this folder.
 */
export class MetaPagesModule implements AppModule {
  readonly name = "meta-pages";
  readonly port: MetaPagesPort;

  constructor({ store, graph }: MetaPagesModuleDeps = {}) {
    this.port = new MetaPagesService(store ?? new PageConnectionsRepository(), graph ?? new MetaGraphClient());
  }
}
