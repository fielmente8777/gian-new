import { Router, type RequestHandler } from "express";

import { RouteDocs, type HttpMethod, type OperationRecord, type RouteSpec } from "../docs/route-doc.js";
import { Validate } from "../middlewares/validate.middleware.js";

/**
 * Parent of every routes class. Each route is declared with its docs; the DTOs in the spec
 * validate the request (inserted right before the controller) and describe it in /docs.
 *
 *   class AuthRoutes extends BaseRoutes {
 *     constructor(c: AuthController, limit: RequestHandler) {
 *       super("/auth", { tag: "Auth" });
 *       this.post("/login", { summary: "Log in", body: LoginDto, response: { schema: SessionSchema } }, limit, c.login);
 *     }
 *   }
 *
 * Handlers run in the order given; the last one is the controller method.
 */
export abstract class BaseRoutes {
  readonly router: Router = Router();
  private readonly routes: Router = Router();
  private readonly operations: OperationRecord[] = [];

  constructor(
    private readonly prefix = "/",
    private readonly options: { tag?: string } = {},
  ) {
    this.router.use(prefix, this.routes);
    RouteDocs.register(this.router, this.operations);
  }

  protected get(path: string, spec: RouteSpec, ...handlers: RequestHandler[]): void {
    this.add("get", path, spec, handlers);
  }

  protected post(path: string, spec: RouteSpec, ...handlers: RequestHandler[]): void {
    this.add("post", path, spec, handlers);
  }

  protected put(path: string, spec: RouteSpec, ...handlers: RequestHandler[]): void {
    this.add("put", path, spec, handlers);
  }

  protected patch(path: string, spec: RouteSpec, ...handlers: RequestHandler[]): void {
    this.add("patch", path, spec, handlers);
  }

  protected delete(path: string, spec: RouteSpec, ...handlers: RequestHandler[]): void {
    this.add("delete", path, spec, handlers);
  }

  private add(method: HttpMethod, path: string, spec: RouteSpec, handlers: RequestHandler[]): void {
    const controller = handlers.at(-1);
    if (!controller) throw new Error(`${method.toUpperCase()} ${path}: a route needs a controller method`);
    const middlewares = handlers.slice(0, -1);
    const validators =
      spec.validate === false
        ? []
        : [
            spec.params && Validate.params(spec.params),
            spec.query && Validate.query(spec.query),
            spec.body && Validate.body(spec.body),
          ].filter((v): v is RequestHandler => Boolean(v));

    this.routes[method](path, ...middlewares, ...validators, controller);
    this.operations.push({
      method,
      path: BaseRoutes.join(this.prefix, path),
      spec: { ...spec, tags: spec.tags ?? (this.options.tag ? [this.options.tag] : undefined) },
      middlewares: middlewares.map((m) => RouteDocs.middlewareDoc(m)).filter((d) => d !== undefined),
    });
  }

  private static join(prefix: string, path: string): string {
    const joined = `/${prefix}/${path}`.replace(/\/+/g, "/");
    return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
  }
}
