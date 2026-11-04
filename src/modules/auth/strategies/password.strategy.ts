import type { UsersPort } from "../../users/index.js";
import { InvalidCredentialsError } from "../errors/auth.errors.js";
import type { CredentialService } from "../services/credential.service.js";
import type { PasswordService } from "../services/password.service.js";
import type { LoginResult, LoginStrategy } from "./login.strategy.js";

export interface PasswordLoginInput {
  email: string;
  password: string;
}

/** Email + password. Unknown email and wrong password give the same error and take the same time. */
export class PasswordStrategy implements LoginStrategy<PasswordLoginInput> {
  readonly method = "password";

  constructor(
    private readonly users: Pick<UsersPort, "findByEmail">,
    private readonly credentials: CredentialService,
    private readonly passwords: PasswordService,
  ) {}

  async authenticate({ email, password }: PasswordLoginInput): Promise<LoginResult> {
    const user = await this.users.findByEmail(email);
    if (!user) {
      await this.passwords.burn(password);
      throw new InvalidCredentialsError();
    }
    if (!(await this.credentials.verify(user.id, password))) throw new InvalidCredentialsError();
    // a typed email proves nothing about who owns it: password logins are never staff
    return { user, created: false, staff: false };
  }
}
