// Fails (exit 1) when .env.example and the config schemas disagree:
// a schema variable missing from the template, or a template variable no schema reads.
// Run in CI: npm run env:check
import { readFileSync } from "node:fs";

import { configSections } from "../src/config/index.js";

const template = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const inTemplate = new Set(
  template
    .split(/\r?\n/)
    .map((line) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((key): key is string => Boolean(key)),
);

const inSchemas = new Map<string, string>();
for (const section of Object.values(configSections)) {
  for (const key of section.keys) inSchemas.set(key, section.name);
}

const missing = [...inSchemas].filter(([key]) => !inTemplate.has(key)).map(([key, section]) => `[${section}] ${key}`);
const unknown = [...inTemplate].filter((key) => !inSchemas.has(key));

if (missing.length > 0) console.error(`Missing from .env.example:\n  ${missing.join("\n  ")}`);
if (unknown.length > 0) console.error(`In .env.example but read by no schema:\n  ${unknown.join("\n  ")}`);
if (missing.length > 0 || unknown.length > 0) process.exit(1);

console.log(`.env.example is in sync (${inSchemas.size} variables).`);
