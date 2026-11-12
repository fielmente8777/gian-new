import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
} from "../../../shared/errors/http-errors.js";

// Stable codes: the admin console switches on `code`, never on the message.

/** Same answer for unknown, disabled and mismatched accounts, so nobody can probe who is staff. */
export class AdminNotAllowedError extends ForbiddenError {
  constructor() {
    super("This Google account does not have access to the admin console", { code: "ADMIN_NOT_ALLOWED" });
  }
}

export class AdminPermissionDeniedError extends ForbiddenError {
  constructor(permission: string) {
    super(`Missing permission: ${permission}`, { code: "PERMISSION_DENIED" });
  }
}

export class OtpInvalidError extends UnauthorizedError {
  constructor(attemptsLeft: number) {
    super(`That code is not correct. ${attemptsLeft} attempts left.`, { code: "OTP_INVALID" });
  }
}

export class OtpExpiredError extends BadRequestError {
  constructor() {
    super("This code has expired. Please sign in again.", { code: "OTP_EXPIRED" });
  }
}

export class OtpAttemptsExceededError extends TooManyRequestsError {
  constructor() {
    super("Too many wrong codes. Please sign in again.", { code: "OTP_ATTEMPTS_EXCEEDED" });
  }
}

export class OtpResendUnavailableError extends TooManyRequestsError {
  constructor() {
    super("A new code cannot be sent yet. Wait a moment, or sign in again.", { code: "OTP_RESEND_UNAVAILABLE" });
  }
}

/** Also the answer for a client outside someone's assigned properties. */
export class ClientNotFoundError extends NotFoundError {
  constructor() {
    super("This client does not exist", { code: "CLIENT_NOT_FOUND" });
  }
}

export class PropertyNotFoundError extends NotFoundError {
  constructor() {
    super("One of these properties does not exist", { code: "PROPERTY_NOT_FOUND" });
  }
}

export class ClientUserNotFoundError extends NotFoundError {
  constructor() {
    super("This person is not on the client's team", { code: "CLIENT_USER_NOT_FOUND" });
  }
}

export class ClientAccountNotFoundError extends NotFoundError {
  constructor() {
    super("This client has no dashboard account to open", { code: "CLIENT_ACCOUNT_NOT_FOUND" });
  }
}

export class ClientAccountInactiveError extends ConflictError {
  constructor() {
    super("This client's dashboard account is turned off", { code: "CLIENT_ACCOUNT_INACTIVE" });
  }
}

export class SubscriptionNotFoundError extends NotFoundError {
  constructor() {
    super("This client has no subscription", { code: "SUBSCRIPTION_NOT_FOUND" });
  }
}

export class PlanNotFoundError extends BadRequestError {
  constructor() {
    super("This plan does not exist", { code: "PLAN_NOT_FOUND" });
  }
}

export class AppNotFoundError extends BadRequestError {
  constructor() {
    super("One of these apps does not exist", { code: "APP_NOT_FOUND" });
  }
}

export class DeleteConfirmationError extends BadRequestError {
  constructor() {
    super("Type the hotel's name exactly to confirm the delete", { code: "CONFIRMATION_MISMATCH" });
  }
}

export class BulkConfirmationError extends BadRequestError {
  constructor(count: number) {
    super(
      `Type DELETE ${count} to confirm deleting ${count === 1 ? "this client" : `these ${count} clients`} forever`,
      {
        code: "CONFIRMATION_MISMATCH",
      },
    );
  }
}

export class ClientNotInTrashError extends ConflictError {
  constructor() {
    super("This client is not in the trash", { code: "CLIENT_NOT_IN_TRASH" });
  }
}

export class TeamMemberNotFoundError extends NotFoundError {
  constructor() {
    super("This staff member does not exist", { code: "TEAM_MEMBER_NOT_FOUND" });
  }
}

export class TeamMemberExistsError extends ConflictError {
  constructor() {
    super("This email is already on the team", { code: "TEAM_MEMBER_EXISTS" });
  }
}

export class TeamMemberDisabledError extends ConflictError {
  constructor() {
    super("This staff member is turned off. Turn them on before sending an invite.", { code: "TEAM_MEMBER_DISABLED" });
  }
}

export class CannotChangeOwnAccessError extends ConflictError {
  constructor() {
    super("You cannot change your own role or status. Ask another super admin.", { code: "CANNOT_CHANGE_OWN_ACCESS" });
  }
}

export class SuperAdminMinimumError extends ConflictError {
  constructor(minimum: number) {
    super(`The team must keep at least ${minimum} active super admins. Promote someone else first.`, {
      code: "SUPER_ADMIN_MINIMUM",
    });
  }
}

export class OtpSendFailedError extends ServiceUnavailableError {
  constructor(cause: unknown) {
    super("The sign-in code could not be emailed. Please try again.", { code: "OTP_SEND_FAILED", cause });
  }
}

export class MetaPageNotFoundError extends NotFoundError {
  constructor() {
    super("No Meta connection has this page", { code: "META_PAGE_NOT_FOUND" });
  }
}

export class MetaConnectionNotFoundError extends NotFoundError {
  constructor() {
    super("This Meta connection does not exist", { code: "META_CONNECTION_NOT_FOUND" });
  }
}

/** An admin may only move pages that are unlinked or linked to one of their own properties. */
export class MetaPageOutOfScopeError extends ForbiddenError {
  constructor() {
    super("This page belongs to a client outside your properties", { code: "META_PAGE_OUT_OF_SCOPE" });
  }
}
