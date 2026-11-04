import type { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

import { RouteDocs } from "../docs/route-doc.js";
import { TooManyRequestsError } from "../errors/http-errors.js";

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  /** Extra part of the key besides the client IP, e.g. the email being logged in to. */
  key?: (req: Request) => string;
  /**
   * Only count failed requests, e.g. login attempts. A request failed when its status is
   * >= 400 or the handler set `res.locals.rateLimitFailure = true` (legacy routes answer
   * failures with 200 + `{ Status: false }`, like nexon).
   */
  skipSuccessfulRequests?: boolean;
  /** Custom response, e.g. the old nexon shape on legacy routes. Default: our 429 error. */
  onLimit?: RequestHandler;
}

/**
 * Builds rate limiters. The store is in memory (one process), which is enough while
 * gian-new runs as a single container; switch to a Redis store when it scales out.
 */
export class RateLimiter {
  static create(options: RateLimitOptions): RequestHandler {
    const limiter = rateLimit({
      windowMs: options.windowMs,
      limit: options.limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
      requestWasSuccessful: (_req, res) => res.statusCode < 400 && res.locals.rateLimitFailure !== true,
      // ipKeyGenerator groups IPv6 addresses by subnet, so one client cannot rotate addresses
      keyGenerator: (req) => {
        const ip = ipKeyGenerator(req.ip ?? "unknown");
        return options.key ? `${ip}:${options.key(req)}` : ip;
      },
      handler: options.onLimit ?? ((_req, _res, next) => next(new TooManyRequestsError())),
    });
    return RouteDocs.describe(limiter, {
      errors: { 429: `RATE_LIMITED (${options.limit} per ${Math.round(options.windowMs / 60_000)} min)` },
    });
  }

  /** Requests per minute per IP for the whole API; 0 turns it off. */
  static perMinute(limit: number): RequestHandler | undefined {
    return limit > 0 ? RateLimiter.create({ windowMs: 60_000, limit }) : undefined;
  }
}
