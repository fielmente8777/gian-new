import { pino, type Logger as PinoLogger, type LoggerOptions } from "pino";

import type { AppConfig } from "../../config/index.js";
import { ErrorSerializer } from "./error-serializer.js";
import { PrettyStream } from "./pretty-stream.js";

export type Logger = PinoLogger;

// Never write these to the logs, wherever they appear in a logged object.
const REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.currentPassword",
  "*.newPassword",
  "*.accesskey",
  "*.oldAccessId",
  "*.newAccessId",
  "*.token",
  "*.refreshToken",
  "*.idToken",
];

/**
 * One logger for the whole process; modules get it through their constructor.
 * - pretty (development): coloured, one line per request, see PrettyStream.
 * - json (staging/production): one JSON object per line with requestId, for CloudWatch.
 * Use structured fields, not string building:  logger.info({ ndid, hid }, "booking created")
 */
export class LoggerFactory {
  static create(config: AppConfig): Logger {
    const options: LoggerOptions = {
      level: config.LOG_LEVEL,
      base: { service: "gian-new", env: config.APP_ENV },
      redact: { paths: REDACT, censor: "[redacted]" },
      serializers: { err: ErrorSerializer.serialize },
      timestamp: pino.stdTimeFunctions.isoTime,
    };
    if (LoggerFactory.format(config) === "pretty") {
      const stream = PrettyStream.create();
      if (stream) return pino(options, stream);
      const logger = pino(options);
      logger.warn("LOG_FORMAT=pretty but pino-pretty is not installed (npm install); logging JSON");
      return logger;
    }
    return pino(options);
  }

  static format(config: AppConfig): "pretty" | "json" {
    return config.LOG_FORMAT ?? (config.NODE_ENV === "development" ? "pretty" : "json");
  }
}
