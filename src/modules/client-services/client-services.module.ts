import type { Mailer } from "../../integrations/mail/mailer.js";
import type { Logger } from "../../shared/logger/logger.js";
import type { AppModule } from "../../shared/module/app-module.js";
import type { SubscriptionsPort } from "../subscriptions/index.js";
import type { ClientServicesConfig } from "./config/client-services.config.js";
import { ClientServicesRepository } from "./repositories/client-services.repository.js";
import { ServiceEnforcer, type DigestRecipients } from "./services/service-enforcer.js";
import type { ClientServicesPort } from "./types/client-services.types.js";

export interface ClientServicesModuleDeps {
  config: ClientServicesConfig;
  subscriptions: SubscriptionsPort;
  mailer: Mailer;
  recipients: DigestRecipients;
  logger: Logger;
  /** tests pass an in-memory store */
  store?: ClientServicesPort;
}

/**
 * The services staff can stop for a client (chatbot, leads), and the enforcer that makes the
 * shared database match them. See the README in this folder.
 */
export class ClientServicesModule implements AppModule {
  readonly name = "client-services";
  readonly port: ClientServicesPort;
  readonly enforcer: ServiceEnforcer;
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: ClientServicesModuleDeps) {
    this.port = deps.store ?? new ClientServicesRepository();
    this.enforcer = new ServiceEnforcer(
      this.port,
      deps.subscriptions,
      deps.mailer,
      deps.recipients,
      deps.logger,
      deps.config.CLIENT_SERVICES_FOLLOW_EXPIRY,
    );
  }

  async init(): Promise<void> {
    if (this.port instanceof ClientServicesRepository) await this.port.ensureIndexes();
    const seconds = this.deps.config.CLIENT_SERVICES_SWEEP_SECONDS;
    if (seconds > 0) {
      let running = false;
      this.timer = setInterval(() => {
        if (running) return;
        running = true;
        void this.enforcer
          .sweep()
          .catch((err: unknown) => this.deps.logger.error({ err }, "client services sweep failed"))
          .finally(() => (running = false));
      }, seconds * 1000);
      this.timer.unref();
    }
  }
}
