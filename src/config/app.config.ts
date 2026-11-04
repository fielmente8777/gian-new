import { z } from "zod";

import { ConfigSection, type ConfigValue } from "./config-section.js";
import { csv, flag, nonNegativeInt, port, positiveInt } from "./env.schemas.js";

const schema = z
  .object({
    // how Node and libraries behave (express hides stack traces in production)
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // which deployment this is; staging runs with NODE_ENV=production
    APP_ENV: z.enum(["development", "staging", "production"]).default("development"),

    PORT: port.default(4000),
    // public base URL of this API (OAuth callbacks, links in emails)
    PUBLIC_URL: z.url().default("http://localhost:4000"),

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    // "pretty" = coloured one-line-per-event logs for people; "json" = one JSON object per line for
    // CloudWatch / log tools. Empty: pretty in development, json everywhere else.
    LOG_FORMAT: z.enum(["pretty", "json"]).optional(),

    // Swagger UI at /docs and the spec at /docs/openapi.json. Empty: on everywhere except APP_ENV=production.
    API_DOCS_ENABLED: flag.optional(),

    // allowed browser origins; "*" only outside production
    CORS_ORIGINS: csv.default([]),
    // proxies in front of the app (nginx = 1); needed for correct client IPs
    TRUST_PROXY: nonNegativeInt.default(0),

    JSON_BODY_LIMIT: z
      .string()
      .regex(/^\d+(b|kb|mb)$/, 'must look like "100kb" or "1mb"')
      .default("100kb"),
    // requests per minute per IP; 0 disables the limiter
    RATE_LIMIT_MAX: nonNegativeInt.default(300),

    // time to finish in-flight requests on SIGTERM before forcing exit
    SHUTDOWN_TIMEOUT_MS: positiveInt.default(15_000),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV !== "development" && env.NODE_ENV !== "production") {
      ctx.addIssue({
        code: "custom",
        path: ["NODE_ENV"],
        message: `must be "production" when APP_ENV is "${env.APP_ENV}"`,
      });
    }
    if (env.APP_ENV === "production" && env.CORS_ORIGINS.includes("*")) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGINS"],
        message: 'must list real origins in production, not "*"',
      });
    }
  });

export const appConfig = new ConfigSection("app", schema);
export type AppConfig = ConfigValue<typeof appConfig>;
