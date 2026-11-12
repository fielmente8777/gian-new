import {
  ConflictError,
  ForbiddenError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../../../shared/errors/http-errors.js";

// Stable codes: clients switch on `code`, never on the message.

export class MissingTokenError extends UnauthorizedError {
  constructor() {
    super("Authorization: Bearer <token> header is required", { code: "TOKEN_MISSING" });
  }
}

export class InvalidTokenError extends UnauthorizedError {
  constructor() {
    super("Token is invalid", { code: "TOKEN_INVALID" });
  }
}

export class TokenExpiredError extends UnauthorizedError {
  constructor() {
    super("Token has expired", { code: "TOKEN_EXPIRED" });
  }
}

export class InvalidCredentialsError extends UnauthorizedError {
  constructor(code = "INVALID_CREDENTIALS", message = "Invalid email or password") {
    super(message, { code });
  }
}

export class InvalidRefreshTokenError extends UnauthorizedError {
  constructor() {
    super("Session expired, please log in again", { code: "REFRESH_TOKEN_INVALID" });
  }
}

/**
 * Another refresh with the same cookie is finishing at this very moment (two tabs, or a page
 * reloaded mid-refresh). Nothing is wrong with the session: the cookie is kept and the client
 * tries again in a moment.
 */
export class RefreshInProgressError extends ConflictError {
  constructor() {
    super("The session is being renewed, please try again", { code: "REFRESH_IN_PROGRESS" });
  }
}

/** A refresh token was used twice: probably stolen. The whole session family is revoked. */
export class RefreshTokenReuseError extends UnauthorizedError {
  constructor() {
    super("Session revoked for security reasons, please log in again", { code: "REFRESH_TOKEN_REUSED" });
  }
}

export class InvalidGoogleTokenError extends UnauthorizedError {
  constructor() {
    super("Google sign-in could not be verified", { code: "GOOGLE_TOKEN_INVALID" });
  }
}

export class AccountInactiveError extends ForbiddenError {
  constructor() {
    super("Account inactive. Please contact admin.", { code: "ACCOUNT_INACTIVE" });
  }
}

/** The user document has no ndid, so no tenant can be put in the token. */
export class AccountNotReadyError extends ForbiddenError {
  constructor() {
    super("Account is not set up yet. Please contact support.", { code: "ACCOUNT_NOT_READY" });
  }
}

export class PermissionDeniedError extends ForbiddenError {
  constructor(permission: string) {
    super(`Missing permission: ${permission}`, { code: "PERMISSION_DENIED" });
  }
}

export class EmailTakenError extends ConflictError {
  constructor() {
    super("An account with this email already exists", { code: "EMAIL_TAKEN" });
  }
}

export class GoogleLoginDisabledError extends ServiceUnavailableError {
  constructor() {
    super("Google sign-in is not configured", { code: "GOOGLE_LOGIN_DISABLED" });
  }
}
