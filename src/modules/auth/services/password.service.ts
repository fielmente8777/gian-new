import bcrypt from "bcrypt";

/** bcrypt hashing for passwords stored by gian-new (auth_credentials). */
export class PasswordService {
  private dummyHash?: Promise<string>;

  constructor(private readonly rounds: number) {}

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds);
  }

  verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /**
   * Spends the same time as a real check. Called when the email does not exist, so
   * response time does not reveal which emails have accounts.
   */
  async burn(plain: string): Promise<void> {
    this.dummyHash ??= bcrypt.hash("dummy-password-for-timing", this.rounds);
    await bcrypt.compare(plain, await this.dummyHash);
  }
}
