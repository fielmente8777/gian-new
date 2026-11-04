import type { z } from "zod";

export type EnvSource = Record<string, string | undefined>;

/**
 * One named group of env variables (app, database, auth, …) with the zod schema that
 * validates them. Global config, every module and every integration declares its own
 * section; `Env.validate` checks all of them at boot.
 */
export class ConfigSection<TSchema extends z.ZodObject = z.ZodObject> {
  constructor(
    readonly name: string,
    readonly schema: TSchema,
  ) {}

  /** Every variable this section reads; used to keep .env.example complete. */
  get keys(): string[] {
    return Object.keys(this.schema.shape);
  }
}

/** The typed, frozen value a section produces, e.g. `ConfigValue<typeof authConfig>`. */
export type ConfigValue<S> = S extends ConfigSection<infer T> ? Readonly<z.output<T>> : never;

/** `{ app: appConfig, auth: authConfig }` → `{ app: AppConfig, auth: AuthConfig }` */
export type ConfigOf<T extends Record<string, ConfigSection>> = Readonly<{ [K in keyof T]: ConfigValue<T[K]> }>;
