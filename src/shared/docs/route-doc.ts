import type { RequestHandler, Router } from "express";
import type { z } from "zod";

import type { DtoClass } from "../http/base-dto.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** A request header the route reads, e.g. X-Client-Platform. */
export interface HeaderDoc {
  name: string;
  description: string;
  required?: boolean;
  enum?: string[];
}

/**
 * Everything the API docs say about one route. Routes classes pass it with the path, so a
 * route cannot exist without its docs, and the DTOs that validate the request are the same
 * ones that describe it (see BaseRoutes).
 */
export interface RouteSpec {
  summary: string;
  description?: string;
  /** default: the tag of the routes class */
  tags?: readonly string[];
  /** validated before the controller runs, and documented */
  params?: DtoClass;
  query?: DtoClass;
  body?: DtoClass;
  headers?: HeaderDoc[];
  /** the success response; `schema` is the `data` inside the envelope (or the raw body when `envelope: false`) */
  response?: { status?: 200 | 201 | 204; schema?: z.ZodType; description?: string };
  /** expected failures besides the ones middlewares add (401/403/429), e.g. `{ 409: "EMAIL_TAKEN" }` */
  errors?: Partial<Record<number, string>>;
  /** this route reads the refresh-token cookie */
  refreshCookie?: boolean;
  /** body is not the `{ success, data }` envelope (old nexon paths, JWKS) */
  envelope?: boolean;
  /**
   * false = the DTOs only document the request; the controller validates itself (old nexon
   * paths must answer bad input with nexon's own body, not our 400 envelope)
   */
  validate?: boolean;
  deprecated?: boolean;
}

/** What a middleware adds to the docs of every route that uses it (auth → bearer + 401, rate limit → 429). */
export interface MiddlewareDoc {
  bearer?: boolean;
  permission?: string;
  errors?: Partial<Record<number, string>>;
}

export interface OperationRecord {
  method: HttpMethod;
  /** Express path relative to where the router is mounted, e.g. "/auth/login" */
  path: string;
  spec: RouteSpec;
  middlewares: MiddlewareDoc[];
}

const MIDDLEWARE_DOC = Symbol.for("gian-new.middlewareDoc");
const routerOperations = new WeakMap<Router, OperationRecord[]>();

/** Links routers and middlewares to their docs. */
export class RouteDocs {
  /** Marks a middleware so every route using it documents what it does. Returns the same function. */
  static describe<T extends RequestHandler>(handler: T, doc: MiddlewareDoc): T {
    Object.defineProperty(handler, MIDDLEWARE_DOC, { value: doc });
    return handler;
  }

  static middlewareDoc(handler: RequestHandler): MiddlewareDoc | undefined {
    return (handler as unknown as Record<symbol, MiddlewareDoc | undefined>)[MIDDLEWARE_DOC];
  }

  static register(router: Router, operations: OperationRecord[]): void {
    routerOperations.set(router, operations);
  }

  /** The operations declared on this router (empty for routers not built with BaseRoutes). */
  static of(router: Router): readonly OperationRecord[] {
    return routerOperations.get(router) ?? [];
  }
}
