import type { IncomingMessage, ServerResponse } from "node:http";

import type { Request, RequestHandler } from "express";
import { pinoHttp } from "pino-http";

import "../http/express-request.js";
import { ErrorSerializer } from "../logger/error-serializer.js";
import type { Logger } from "../logger/logger.js";

const QUIET_PATHS = ["/health", "/docs"];

const url = (req: IncomingMessage) => (req as Request).originalUrl ?? req.url ?? "";

/**
 * One access-log line per request, written when the response is sent:
 *   message  "POST /api/v1/auth/login 200 45ms"
 *   fields   req { method, url }, res { statusCode }, responseTime, requestId, userId (when signed in)
 * 2xx/3xx = info, 4xx = warn, 5xx = error (with the error and its stack, set by the error
 * handler as res.err, so a failure is one log entry). Health checks and /docs are not logged.
 */
export class RequestLogger {
  static create(logger: Logger): RequestHandler {
    return pinoHttp({
      logger,
      genReqId: (req) => (req as Request).requestId,
      quietReqLogger: true,
      // one name for the request id in every log line (the error handler uses it too)
      customAttributeKeys: { reqId: "requestId" },
      autoLogging: { ignore: (req) => QUIET_PATHS.some((path) => url(req).startsWith(path)) },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      customSuccessMessage: (req, res, responseTime) =>
        `${req.method} ${url(req)} ${res.statusCode} ${Math.round(responseTime)}ms`,
      customErrorMessage: (req, res, err) => `${req.method} ${url(req)} ${res.statusCode} ${err.message}`,
      customSuccessObject: (req, _res, value) => RequestLogger.withUser(req, value),
      customErrorObject: (req, _res, _err, value) => RequestLogger.withUser(req, value),
      serializers: {
        err: ErrorSerializer.serialize,
        req: (req: IncomingMessage) => ({ method: req.method, url: url(req) }),
        res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
      },
    });
  }

  private static withUser(req: IncomingMessage, value: Record<string, unknown>) {
    const request = req as Request & { auth?: { userId: string; actor?: { email: string } | null } };
    return {
      ...value,
      ...(request.auth ? { userId: request.auth.userId } : {}),
      ...(request.auth?.actor ? { actingStaff: request.auth.actor.email } : {}),
    };
  }
}
