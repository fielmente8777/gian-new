import type { UserRecord } from "../../users/index.js";
import type { LoginMethod } from "../types/auth.types.js";

export interface LoginResult {
  user: UserRecord;
  /** true when this login created the account (first Google sign-in) */
  created: boolean;
  /** the login proves platform staff (see StaffPolicy) */
  staff: boolean;
}

/**
 * One way of proving who you are. A new method (phone OTP, magic link) is a new class
 * implementing this, not another `if` in AuthService (open/closed, README §2).
 */
export interface LoginStrategy<TInput> {
  readonly method: LoginMethod;
  authenticate(input: TInput): Promise<LoginResult>;
}
