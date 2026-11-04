import { AppError, type AppErrorOptions, type ErrorDetail } from "./app-error.js";

// The generic HTTP errors. Modules subclass these with their own codes
// (e.g. InvalidCredentialsError extends UnauthorizedError).

interface Options extends AppErrorOptions {
  code?: string;
}

export class ValidationError extends AppError {
  constructor(details: ErrorDetail[], message = details[0]?.message ?? "Invalid request") {
    super(400, "VALIDATION_FAILED", message, { details });
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", options: Options = {}) {
    super(400, options.code ?? "BAD_REQUEST", message, options);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required", options: Options = {}) {
    super(401, options.code ?? "UNAUTHORIZED", message, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource", options: Options = {}) {
    super(403, options.code ?? "FORBIDDEN", message, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found", options: Options = {}) {
    super(404, options.code ?? "NOT_FOUND", message, options);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", options: Options = {}) {
    super(409, options.code ?? "CONFLICT", message, options);
  }
}

export class UnprocessableError extends AppError {
  constructor(message: string, options: Options = {}) {
    super(422, options.code ?? "UNPROCESSABLE", message, options);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests, try again later", options: Options = {}) {
    super(429, options.code ?? "RATE_LIMITED", message, options);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable", options: Options = {}) {
    super(503, options.code ?? "SERVICE_UNAVAILABLE", message, options);
  }
}
