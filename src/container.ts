import type { Config } from "./config/index.js";
import { AuthModule } from "./modules/auth/index.js";
import { HealthModule } from "./modules/health/index.js";
import { UsersModule } from "./modules/users/index.js";
import { Database } from "./shared/database/database.js";
import { EventBus } from "./shared/events/event-bus.js";
import { LoggerFactory, type Logger } from "./shared/logger/logger.js";
import type { AppModule } from "./shared/module/app-module.js";

/**
 * Composition root: builds the shared infrastructure, then each module in dependency
 * order, handing each one only what it needs from the others. Nothing else lives here;
 * every module wires its own classes in its *.module.ts.
 */
export class Container {
  readonly logger: Logger;
  readonly database: Database;
  readonly events: EventBus;
  readonly modules: readonly AppModule[];

  constructor(readonly config: Config) {
    this.logger = LoggerFactory.create(config.app);
    this.database = new Database(config.database, this.logger);
    this.events = new EventBus(this.logger);

    const health = new HealthModule({ database: this.database });
    const users = new UsersModule();
    const auth = new AuthModule({ config: config.auth, logger: this.logger, events: this.events, users: users.port });

    this.modules = [health, users, auth];
  }
}
