import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from "../../../shared/errors/http-errors.js";

// Stable codes: the admin console switches on `code`, never on the message.

/** A deduction bigger than what the client can use right now (balance minus running requests). */
export class InsufficientCreditsError extends UnprocessableError {
  constructor(readonly available: number) {
    super(`This client only has ${available} available credits`, { code: "AI_CREDITS_INSUFFICIENT" });
  }
}

/** The idempotency key was already used for a different client. Same code as gian. */
export class IdempotencyKeyReusedError extends ConflictError {
  constructor() {
    super("This request key was already used for another client", { code: "DUPLICATE_REQUEST" });
  }
}

export class DuplicatePricingError extends ConflictError {
  constructor() {
    super("Pricing for this provider and model already exists", { code: "AI_PRICING_EXISTS" });
  }
}

export class PricingNotFoundError extends NotFoundError {
  constructor() {
    super("This pricing row does not exist", { code: "AI_PRICING_NOT_FOUND" });
  }
}

export class PackageNotFoundError extends NotFoundError {
  constructor() {
    super("This credit package does not exist", { code: "AI_PACKAGE_NOT_FOUND" });
  }
}

export class TopUpNotFoundError extends NotFoundError {
  constructor() {
    super("This OpenAI top-up does not exist", { code: "OPENAI_TOPUP_NOT_FOUND" });
  }
}

export class InvalidThresholdsError extends BadRequestError {
  constructor() {
    super("The critical threshold must be below the low threshold", { code: "AI_THRESHOLDS_INVALID" });
  }
}

/** OPENAI_ADMIN_KEY is not set, so OpenAI's cost data can't be read. */
export class OpenAiNotConfiguredError extends ConflictError {
  constructor() {
    super("The OpenAI admin key is not set on the server", { code: "OPENAI_NOT_CONFIGURED" });
  }
}

/** Another server (or an earlier click) is syncing OpenAI costs right now. */
export class CostSyncBusyError extends ConflictError {
  constructor() {
    super("OpenAI costs are being synced right now. Try again in a minute.", { code: "OPENAI_SYNC_BUSY" });
  }
}
