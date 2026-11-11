import { NotFoundError } from "../../../shared/errors/http-errors.js";

// Stable codes: the admin console switches on `code`, never on the message.

export class NoSubscriptionToRemindError extends NotFoundError {
  constructor() {
    super("This client has no subscription to remind them about", { code: "SUBSCRIPTION_NOT_FOUND" });
  }
}
