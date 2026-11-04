// Writes the generated OpenAPI spec to docs/openapi.json without starting the server or
// touching the database. Use it to generate a client (e.g. Kotlin for the Android app with
// openapi-generator), import into Postman, or diff the API between two commits in review.
//   npm run docs:export
import { mkdirSync, writeFileSync } from "node:fs";

import { App } from "../src/app.js";
import { loadConfig } from "../src/config/index.js";
import { Container } from "../src/container.js";

const config = loadConfig();
const container = new Container(config);
const app = new App({
  config: { ...config.app, API_DOCS_ENABLED: true },
  logger: container.logger,
  modules: container.modules,
  refreshCookieName: config.auth.AUTH_REFRESH_COOKIE_NAME,
});

const file = new URL("../docs/openapi.json", import.meta.url);
mkdirSync(new URL("../docs/", import.meta.url), { recursive: true });
writeFileSync(file, `${JSON.stringify(app.openApi, null, 2)}\n`);
console.log(
  `OpenAPI spec written to docs/openapi.json (${Object.keys((app.openApi?.paths as object) ?? {}).length} paths)`,
);
