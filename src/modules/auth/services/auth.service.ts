import type { EventBus } from "../../../shared/events/event-bus.js";
import { NotFoundError } from "../../../shared/errors/http-errors.js";
import type { UserRecord, UsersPort } from "../../users/index.js";
import {
  AccountInactiveError,
  EmailTakenError,
  InvalidCredentialsError,
  StaffOnlyError,
} from "../errors/auth.errors.js";
import "../events/auth.events.js";
import type { GoogleLoginInput, GoogleStrategy } from "../strategies/google.strategy.js";
import type { LoginResult } from "../strategies/login.strategy.js";
import type { PasswordLoginInput, PasswordStrategy } from "../strategies/password.strategy.js";
import type { AuthContext } from "../types/auth-context.js";
import type { ClientInfo } from "../types/auth.types.js";
import { LegacyPasswordHash } from "./legacy-password-hash.js";
import type { CredentialService } from "./credential.service.js";
import type { SessionService } from "./session.service.js";

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  phone?: string;
}

/** Which client account a staff member wants to open: by owner email or by tenant id. */
export type SwitchTarget = { email: string } | { ndid: string };

/**
 * Answers "who is this user?" for every login method, and owns the account rules
 * (inactive accounts, duplicate emails, password changes, staff switching accounts).
 * It never creates tokens: the controller decides which kind (new session, or a
 * nexon-style token on legacy paths).
 */
export class AuthService {
  constructor(
    private readonly users: UsersPort,
    private readonly passwordLogin: PasswordStrategy,
    private readonly googleLogin: GoogleStrategy,
    private readonly credentials: CredentialService,
    private readonly sessions: SessionService,
    private readonly events: EventBus,
  ) {}

  async loginWithPassword(input: PasswordLoginInput, client: ClientInfo): Promise<LoginResult> {
    const result = await this.passwordLogin.authenticate(input);
    this.admit(result.user, "password", client);
    return result;
  }

  async loginWithGoogle(input: GoogleLoginInput, client: ClientInfo): Promise<LoginResult> {
    const result = await this.googleLogin.authenticate(input);
    if (result.created) this.registered(result.user, "google");
    this.admit(result.user, "google", client);
    return result;
  }

  /** Self sign-up of a new account owner (new ndid, full access), checked by email only. */
  async register(input: RegisterInput): Promise<UserRecord> {
    if (await this.users.findByEmail(input.email)) throw new EmailTakenError();
    const user = await this.users.createOwner({
      email: input.email,
      name: input.name,
      phone: input.phone,
      legacyPasswordHash: LegacyPasswordHash.unusable(),
    });
    await this.credentials.setPassword(user.id, input.password);
    this.registered(user, "password");
    return user;
  }

  /** Checks the current password, sets the new one, and ends every other session of the user. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId: string | null,
  ): Promise<void> {
    if (!(await this.credentials.verify(userId, currentPassword))) {
      throw new InvalidCredentialsError("CURRENT_PASSWORD_INVALID", "Current password is incorrect");
    }
    await this.credentials.setPassword(userId, newPassword);
    await this.sessions.endOthers(userId, keepSessionId);
    this.events.emit("user.password_changed", { userId });
  }

  /**
   * A staff member opens a client account (replaces nexon /admin/switch-account, which
   * signed any body for anyone). Returns the account owner; every switch is an event
   * (audit trail) and the resulting token names the staff member.
   */
  async switchAccount(actor: AuthContext, target: SwitchTarget): Promise<UserRecord> {
    if (!actor.isStaff) throw new StaffOnlyError();
    const user =
      "email" in target ? await this.users.findByEmail(target.email) : await this.users.findOwnerByNdid(target.ndid);
    if (!user) throw new NotFoundError("Client account not found", { code: "ACCOUNT_NOT_FOUND" });
    if (!user.isActive) throw new AccountInactiveError();
    this.events.emit("user.account_switched", {
      actorId: actor.userId,
      actorEmail: actor.email,
      userId: user.id,
      ndid: user.ndid ?? "",
    });
    return user;
  }

  async getUser(userId: string): Promise<UserRecord> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError("User not found", { code: "USER_NOT_FOUND" });
    if (!user.isActive) throw new AccountInactiveError();
    return user;
  }

  private admit(user: UserRecord, method: "password" | "google", client: ClientInfo): void {
    if (!user.isActive) throw new AccountInactiveError();
    if (user.ndid)
      this.events.emit("user.logged_in", {
        userId: user.id,
        ndid: user.ndid,
        method,
        ip: client.ip,
        platform: client.platform,
      });
  }

  private registered(user: UserRecord, method: "password" | "google"): void {
    if (user.ndid) this.events.emit("user.registered", { userId: user.id, ndid: user.ndid, email: user.email, method });
  }
}
