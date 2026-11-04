import { existsSync } from "node:fs";
import path from "node:path";

import type { ConfigOf, ConfigSection, EnvSource } from "./config-section.js";
import { EnvValidationError } from "./env-validation.error.js";

/**
 * The only class that reads process.env. Everything else receives typed config
 * through its constructor.
 */
export class Env {
  /** Project root .env (same path from src/config and dist/config). */
  static readonly defaultFile = path.resolve(import.meta.dirname, "../../.env");

  /**
   * Loads the .env file into process.env if it exists. Variables already set by the
   * host (Docker env_file, EC2, CI) always win over the file. Tests never read .env.
   */
  static loadFile(file = Env.defaultFile): void {
    if (process.env.NODE_ENV === "test") return;
    if (existsSync(file)) process.loadEnvFile(file);
  }

  /**
   * Validates every section and returns the typed, frozen config. Collects the
   * problems of all sections first, so one run shows everything that is wrong.
   */
  static validate<const T extends Record<string, ConfigSection>>(
    sections: T,
    source: EnvSource = process.env,
  ): ConfigOf<T> {
    // `KEY=` in a .env file means "not set", so defaults still apply
    const env = Object.fromEntries(
      Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""),
    );

    const problems: string[] = [];
    const config: Record<string, unknown> = {};

    for (const [key, section] of Object.entries(sections)) {
      const result = section.schema.safeParse(env);
      if (result.success) {
        config[key] = Object.freeze(result.data);
        continue;
      }
      for (const issue of result.error.issues) {
        const key = issue.path.join(".");
        const message = key && env[key] === undefined ? "is required (not set)" : issue.message;
        problems.push(`[${section.name}] ${key || "(section)"}: ${message}`);
      }
    }

    if (problems.length > 0) throw new EnvValidationError(problems);
    return Object.freeze(config) as ConfigOf<T>;
  }
}
