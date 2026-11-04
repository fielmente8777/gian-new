import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { App } from "./app.js";
import type { Container } from "./container.js";

/**
 * Process lifecycle.
 * start: MongoDB → modules.init() → HTTP.
 * stop (SIGTERM from Docker / Ctrl+C): stop accepting, finish in-flight requests, modules, MongoDB.
 */
export class Server {
  private http?: HttpServer;

  constructor(private readonly container: Container) {}

  get port(): number | undefined {
    return (this.http?.address() as AddressInfo | null)?.port;
  }

  async start(): Promise<void> {
    const { config, database, logger, modules } = this.container;
    await database.connect();
    for (const module of modules) await module.init?.();

    const app = new App({
      config: config.app,
      logger,
      modules,
      refreshCookieName: config.auth.AUTH_REFRESH_COOKIE_NAME,
    });
    const http = createServer(app.express);
    // longer than nginx / load-balancer idle timeouts, so they never reuse a closed socket
    http.keepAliveTimeout = 65_000;
    this.http = http;
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(config.app.PORT, () => resolve());
    });
    logger.info(`gian-new listening on http://localhost:${this.port} (${config.app.APP_ENV})`);
    if (app.openApi) logger.info(`API docs: ${config.app.PUBLIC_URL}/docs  (spec: /docs/openapi.json)`);
  }

  async stop(): Promise<void> {
    const { database, modules, logger } = this.container;
    const http = this.http;
    if (http?.listening) {
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeIdleConnections();
      await closed;
    }
    for (const module of [...modules].reverse()) await module.shutdown?.();
    await database.disconnect();
    logger.info("gian-new stopped");
  }

  handleSignals(): void {
    const { logger, config } = this.container;
    const shutdown = (signal: string) => {
      logger.info({ signal }, "shutting down");
      setTimeout(() => {
        logger.error("shutdown timed out, forcing exit");
        process.exit(1);
      }, config.app.SHUTDOWN_TIMEOUT_MS).unref();
      this.stop()
        .then(() => process.exit(0))
        .catch((err: unknown) => {
          logger.error({ err }, "shutdown failed");
          process.exit(1);
        });
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));
    process.on("uncaughtException", (err) => {
      logger.fatal({ err }, "uncaught exception");
      process.exit(1);
    });
  }
}
