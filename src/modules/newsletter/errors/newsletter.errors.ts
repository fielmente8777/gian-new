import { BadRequestError, ConflictError, NotFoundError } from "../../../shared/errors/http-errors.js";

// Stable codes: the dashboard switches on `code`, never on the message.

export class SubscriberNotFoundError extends NotFoundError {
  constructor() {
    super("This subscriber is not on your list.", { code: "SUBSCRIBER_NOT_FOUND" });
  }
}

export class SubscriberExistsError extends ConflictError {
  constructor() {
    super("This email is already on your list.", { code: "SUBSCRIBER_EXISTS" });
  }
}

/** They unsubscribed themselves: only they can sign up again (from the website box). */
export class SubscriberOptedOutError extends ConflictError {
  constructor() {
    super("This person unsubscribed. They can sign up again from your website.", { code: "SUBSCRIBER_OPTED_OUT" });
  }
}

export class InvalidEmailError extends BadRequestError {
  constructor() {
    super("Please enter a valid email address.", { code: "INVALID_EMAIL" });
  }
}

export class UnknownWebsiteError extends NotFoundError {
  constructor() {
    super("This website is not linked to an Eazotel account.", { code: "UNKNOWN_WEBSITE" });
  }
}
