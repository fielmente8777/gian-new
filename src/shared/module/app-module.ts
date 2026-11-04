import type { Router } from "express";

/** What every module gives the app. container.ts builds them; App mounts their routers. */
export interface AppModule {
  readonly name: string;
  /** Mounted at /api/v1 (new API, strict CORS, cookies allowed). */
  readonly router?: Router;
  /** Mounted at / for paths that must sit at the root: /health/*, /.well-known/*. */
  readonly rootRouter?: Router;
  /** Mounted at / for old nexon paths this module now serves (README §9). Open CORS like nexon. */
  readonly legacyRouter?: Router;
  /** Runs once before the server listens, e.g. to build the indexes of the module's own collections. */
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
}
