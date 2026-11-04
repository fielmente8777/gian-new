import cors from "cors";
import express, { Router, type Express, type RequestHandler } from "express";
import helmet from "helmet";

import type { AppConfig } from "./config/index.js";
import { ApiDocs } from "./shared/docs/api-docs.js";
import { OpenApiBuilder } from "./shared/docs/openapi-builder.js";
import type { Logger } from "./shared/logger/logger.js";
import { ErrorHandler } from "./shared/middlewares/error-handler.middleware.js";
import { RateLimiter } from "./shared/middlewares/rate-limit.middleware.js";
import { RequestIdMiddleware } from "./shared/middlewares/request-id.middleware.js";
import { RequestLogger } from "./shared/middlewares/request-logger.middleware.js";
import type { AppModule } from "./shared/module/app-module.js";

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  modules: readonly AppModule[];
  /** name of the refresh cookie, shown in the API docs */
  refreshCookieName?: string;
}

export const API_PREFIX = "/api/v1";

/**
 * The Express application: middleware order + where each module's routers go.
 * No network or database work here, so tests can build it with fake modules.
 *
 *   request-id → access log → helmet → body parsers → rate limit
 *   /api/v1/*  strict CORS (listed origins, cookies)        → module.router
 *   /*         open CORS (like nexon, no cookies)           → module.rootRouter, module.legacyRouter, /docs
 *   404 → error handler
 */
export class App {
  readonly express: Express;
  /** the generated OpenAPI document, or null when API_DOCS_ENABLED is off */
  readonly openApi: Record<string, unknown> | null;

  constructor({ config, logger, modules, refreshCookieName = "ez_rt" }: AppDeps) {
    const app = express();
    this.express = app;

    app.disable("x-powered-by");
    app.set("trust proxy", config.TRUST_PROXY);

    app.use(RequestIdMiddleware.handle);
    app.use(RequestLogger.create(logger));
    // an API: allow pages on other origins to read responses (booking widgets, hotel sites)
    app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
    app.use(express.json({ limit: config.JSON_BODY_LIMIT }));
    app.use(express.urlencoded({ extended: false, limit: config.JSON_BODY_LIMIT }));
    const limiter = RateLimiter.perMinute(config.RATE_LIMIT_MAX);
    if (limiter) app.use(limiter);

    const api = Router();
    for (const module of modules) if (module.router) api.use(module.router);
    app.use(API_PREFIX, App.apiCors(config.CORS_ORIGINS), api);

    app.use(cors());
    for (const module of modules) if (module.rootRouter) app.use(module.rootRouter);
    for (const module of modules) if (module.legacyRouter) app.use(module.legacyRouter);

    this.openApi = App.docsEnabled(config) ? App.buildDocs(config, modules, refreshCookieName) : null;
    if (this.openApi) app.use(ApiDocs.router(this.openApi));

    const errors = new ErrorHandler();
    app.use(errors.notFound);
    app.use(errors.handle);
  }

  static docsEnabled(config: AppConfig): boolean {
    return config.API_DOCS_ENABLED ?? config.APP_ENV !== "production";
  }

  /** Docs come from the routes the modules registered, so a new endpoint shows up by itself. */
  private static buildDocs(config: AppConfig, modules: readonly AppModule[], refreshCookieName: string) {
    const builder = new OpenApiBuilder({
      title: "Eazotel API",
      version: "1.0",
      serverUrl: config.PUBLIC_URL,
      refreshCookieName,
      description: [
        "The single Eazotel backend, used by the dashboard, the Android app, hotel websites and booking engines.",
        "",
        "**Sign in:** call `POST /api/v1/auth/login` (or `/google`), copy `data.accessToken`, press **Authorize** and paste it.",
        "**Mobile app:** send `X-Client-Platform: android` to get the refresh token in the body instead of a cookie.",
        "**Errors** are always `{ success: false, error: { code, message, details, requestId } }`: switch on `code`.",
        "**Legacy (nexon)** paths keep nexon's exact old request/response shapes for clients that are not updated yet.",
      ].join("\n"),
    });
    for (const module of modules)
      builder.add(module.router, API_PREFIX).add(module.rootRouter).add(module.legacyRouter);
    return builder.build();
  }

  /** Only listed browser origins may call /api/v1 with cookies ("*" = any, development only). */
  private static apiCors(origins: readonly string[]): RequestHandler {
    const any = origins.includes("*");
    return cors({
      origin: (origin, callback) => callback(null, !origin || any || origins.includes(origin)),
      credentials: true,
      exposedHeaders: ["X-Request-Id"],
      maxAge: 600,
    });
  }
}
