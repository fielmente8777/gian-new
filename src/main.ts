import { EnvValidationError, loadConfig, type Config } from "./config/index.js";
import { Container } from "./container.js";
import { Server } from "./server.js";

// HTTP process entry point: validate config → build modules → start.

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  // print every missing/invalid variable at once, without a stack trace
  console.error(error instanceof EnvValidationError ? error.message : error);
  process.exit(1);
}

const container = new Container(config);
const server = new Server(container);
server.handleSignals();

try {
  await server.start();
} catch (err) {
  container.logger.fatal({ err }, "startup failed");
  process.exit(1);
}
