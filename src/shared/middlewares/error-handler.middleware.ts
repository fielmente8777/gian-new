import type { ErrorRequestHandler, RequestHandler } from "express";

import { AppError } from "../errors/app-error.js";
import { NotFoundError } from "../errors/http-errors.js";
import type { ErrorBody } from "../http/api-response.js";
import "../http/express-request.js";

/** The last two middlewares: 404 for unknown routes, then one place that turns errors into responses. */
export class ErrorHandler {
  readonly notFound: RequestHandler = (req, _res, next) => {
    next(new NotFoundError(`Route not found: ${req.method} ${req.path}`, { code: "ROUTE_NOT_FOUND" }));
  };

  // Express recognises an error handler by its 4 parameters, so `_next` must stay.
  readonly handle: ErrorRequestHandler = (err: unknown, req, res, next) => {
    if (res.headersSent) return next(err);

    const error = this.toAppError(err);
    // the access log (RequestLogger) writes this request's single log line, with the error
    // and its stack, when the response finishes
    if (error.status >= 500) res.err = err instanceof Error ? err : new Error(String(err));

    const body: ErrorBody = {
      success: false,
      error: { code: error.code, message: error.message, details: error.details, requestId: req.requestId },
    };
    res.status(error.status).json(body);
  };

  private toAppError(err: unknown): AppError {
    if (err instanceof AppError) return err;
    // errors raised by express.json()
    const type = (err as { type?: unknown } | null)?.type;
    if (type === "entity.parse.failed") return new AppError(400, "INVALID_JSON", "Request body is not valid JSON");
    if (type === "entity.too.large") return new AppError(413, "BODY_TOO_LARGE", "Request body is too large");
    return new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred");
  }
}
