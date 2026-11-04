import { createRequire } from "node:module";

type Colors = Record<"dim" | "green" | "yellow" | "red" | "cyan" | "magenta" | "bold", (text: string) => string>;
type Log = Record<string, unknown>;
type PrettyFactory = (options: Record<string, unknown>) => NodeJS.WritableStream;

// fields shown in the formatted message, or noise for a person reading the terminal
const HIDDEN = "pid,hostname,service,env,req,res,responseTime,requestId,userId,actingStaff";

/**
 * Human-readable logs for development:
 *
 *   10:15:30.123 INFO  POST /api/v1/auth/login 200 45ms  user 6ae9767e  req 2486e52c
 *   10:15:31.004 WARN  POST /api/v1/auth/login 401 82ms  req 9f1c22aa
 *   10:15:32.551 ERROR legacy POST /eazotel/ceateuser failed  req 77ab01cd
 *       err: { type: "Error", message: "…", stack: … }
 *
 * Other structured fields print below the line, indented. pino-pretty is a dev dependency:
 * when it is missing (production image) this returns null and the logger writes JSON.
 */
export class PrettyStream {
  static create(): NodeJS.WritableStream | null {
    let pretty: PrettyFactory;
    try {
      const loaded = createRequire(import.meta.url)("pino-pretty") as PrettyFactory | { default: PrettyFactory };
      pretty = typeof loaded === "function" ? loaded : loaded.default;
    } catch {
      return null;
    }
    return pretty({
      colorize: process.stdout.isTTY ?? false,
      translateTime: "SYS:HH:MM:ss.l",
      ignore: HIDDEN,
      singleLine: false,
      hideObject: false,
      messageFormat: (log: Log, messageKey: string, _level: string, extras: { colors: Colors }) =>
        PrettyStream.format(log, messageKey, extras.colors),
    });
  }

  private static format(log: Log, messageKey: string, c: Colors): string {
    let message = String(log[messageKey] ?? "");

    const status = (log.res as { statusCode?: number } | undefined)?.statusCode;
    if (status !== undefined) {
      // "POST /x 200 45ms" → colour the status by class
      const paint = status >= 500 ? c.red : status >= 400 ? c.yellow : status >= 300 ? c.cyan : c.green;
      message = message.replace(new RegExp(`\\s${status}\\s`), ` ${paint(String(status))} `);
    }

    const tags = [
      typeof log.userId === "string" && `${c.dim("user")} ${c.magenta(log.userId.slice(0, 8))}`,
      typeof log.actingStaff === "string" && `${c.dim("as staff")} ${c.magenta(log.actingStaff)}`,
      typeof log.requestId === "string" && `${c.dim("req")} ${c.dim(log.requestId.slice(0, 8))}`,
    ].filter(Boolean);
    return tags.length > 0 ? `${message}  ${tags.join("  ")}` : message;
  }
}
