import type { Response } from "express";

import type { SuccessBody } from "./api-response.js";

/**
 * Parent of every controller. A controller only translates HTTP: it reads the already
 * validated request, calls a service and writes the response.
 *
 * Express calls handlers as plain functions (`router.post("/x", controller.create)`),
 * which loses `this`. The constructor binds every method of the subclass once, so
 * routes can pass `controller.create` directly without `.bind()`.
 */
export abstract class BaseController {
  constructor() {
    const self = this as unknown as Record<string, unknown>;
    let proto: object | null = Object.getPrototypeOf(this);
    while (proto && proto !== BaseController.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        const value = self[name];
        if (name !== "constructor" && typeof value === "function") self[name] = value.bind(this);
      }
      proto = Object.getPrototypeOf(proto);
    }
  }

  protected ok<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
    const body: SuccessBody<T> = meta ? { success: true, data, meta } : { success: true, data };
    res.status(200).json(body);
  }

  protected created<T>(res: Response, data: T): void {
    res.status(201).json({ success: true, data } satisfies SuccessBody<T>);
  }

  protected noContent(res: Response): void {
    res.status(204).end();
  }
}
