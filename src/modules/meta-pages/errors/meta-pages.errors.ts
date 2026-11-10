import { ConflictError, UnprocessableError } from "../../../shared/errors/http-errors.js";

// Stable codes: the admin console switches on `code`, never on the message.

/** The connection has no Meta token to sync with: someone has to sign in with Meta again. */
export class MetaTokenMissingError extends ConflictError {
  constructor() {
    super("This Meta connection has no token. Sign in with Meta again from the hotel dashboard.", {
      code: "META_TOKEN_MISSING",
    });
  }
}

/** Meta refused the sync, usually because the sign-in expired or was revoked. Meta's message is kept. */
export class MetaSyncFailedError extends UnprocessableError {
  constructor(reason: string) {
    super(
      `Meta refused the sync: ${reason}. Sign in with Meta again from the hotel dashboard if this keeps happening.`,
      {
        code: "META_SYNC_FAILED",
      },
    );
  }
}
