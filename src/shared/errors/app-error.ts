/** One problem with one field of the request, e.g. `{ field: "email", message: "Invalid email" }`. */
export interface ErrorDetail {
  field?: string;
  message: string;
}

export interface AppErrorOptions {
  details?: ErrorDetail[];
  cause?: unknown;
}

/**
 * Parent of every error the API answers on purpose. It carries the HTTP status and a
 * stable `code` that clients can switch on (the message may change, the code may not).
 * Anything that is not an AppError becomes a 500 with a generic message.
 */
export class AppError extends Error {
  readonly details?: ErrorDetail[];

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.details = options.details;
  }
}
