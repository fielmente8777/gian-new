import { randomUUID } from "node:crypto";

import type { RequestHandler } from "express";

import "../http/express-request.js";

const HEADER = "X-Request-Id";
// only accept ids from upstream (nginx, another service) that are safe to log and echo
const SAFE_ID = /^[\w.-]{8,128}$/;

/** Gives every request an id, reused from the incoming header when it is safe, and echoes it back. */
export class RequestIdMiddleware {
  static readonly handle: RequestHandler = (req, res, next) => {
    const incoming = req.get(HEADER);
    req.requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader(HEADER, req.requestId);
    next();
  };
}
