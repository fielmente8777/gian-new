import mongoose from "mongoose";

import type { DatabaseConfig } from "../../config/index.js";
import type { Logger } from "../logger/logger.js";

/**
 * The MongoDB connection (mongoose default connection, so every model registered with
 * `model()` uses it). Same cluster and database (`Courage`) as nexon and gian.
 */
export class Database {
  constructor(
    private readonly config: DatabaseConfig,
    private readonly logger: Logger,
  ) {
    mongoose.set("strictQuery", true);
    // indexes on shared nexon collections are never built from here; modules build
    // the indexes of their own new collections in init() (see AuthModule.init)
    mongoose.set("autoIndex", config.MONGO_AUTO_INDEX);
  }

  async connect(): Promise<void> {
    await mongoose.connect(this.config.MONGO_URI, {
      dbName: this.config.MONGO_DB,
      maxPoolSize: this.config.MONGO_MAX_POOL_SIZE,
      serverSelectionTimeoutMS: this.config.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    });
    this.logger.info({ db: this.config.MONGO_DB }, "MongoDB connected");
  }

  /** True when MongoDB answers a ping; used by /health/ready. */
  async isReady(): Promise<boolean> {
    try {
      await mongoose.connection.db?.admin().ping();
      return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    await mongoose.disconnect();
    this.logger.info("MongoDB disconnected");
  }
}
