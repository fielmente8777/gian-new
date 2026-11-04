import { stdSerializers } from "pino";

export interface SerializedError {
  type: string;
  message: string;
  code?: string | number;
  status?: number;
  stack?: string;
}

/**
 * How errors appear in logs: type, message, code/status and the stack (with every
 * "caused by" appended). Everything else drivers hang on errors (MongoDB's whole topology
 * description, axios configs…) is dropped: it buries the stack and can leak data.
 *
 * Accepts an Error (pino's own `err` key) or an already serialized error (pino-http
 * serializes first and passes `{ type, message, stack, …, raw }`).
 */
export class ErrorSerializer {
  static serialize(value: unknown): unknown {
    const full = ErrorSerializer.expand(value);
    if (!full) return value;
    const { code, status } = full;
    return {
      type: String(full.type ?? "Error"),
      message: String(full.message ?? ""),
      ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
      ...(typeof status === "number" ? { status } : {}),
      ...(typeof full.stack === "string" ? { stack: full.stack } : {}),
    } satisfies SerializedError;
  }

  private static expand(value: unknown): Record<string, unknown> | null {
    if (value instanceof Error) return stdSerializers.err(value) as unknown as Record<string, unknown>;
    if (value && typeof value === "object" && "message" in value && ("stack" in value || "type" in value)) {
      return value as Record<string, unknown>;
    }
    return null;
  }
}
