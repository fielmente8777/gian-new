import type { UsersPort } from "../../users/index.js";
import { GoogleLoginDisabledError, InvalidGoogleTokenError } from "../errors/auth.errors.js";
import { LegacyPasswordHash } from "../services/legacy-password-hash.js";
import type { StaffPolicy } from "../services/staff.policy.js";
import type { GoogleIdentity, GoogleIdentityVerifier } from "../types/auth.types.js";
import type { LoginResult, LoginStrategy } from "./login.strategy.js";

export interface GoogleLoginInput {
  idToken: string;
}

/**
 * "Sign in with Google" (dashboard button, Android/iOS sign-in). Like nexon: an unknown
 * email becomes a new account owner. Unlike nexon: the email must be verified by Google,
 * and the new account gets no password (nexon gave every one of them "Eazotel@123").
 * A verified email on a staff domain (eazotel.com, fielmente.com) makes the session staff.
 */
export class GoogleStrategy implements LoginStrategy<GoogleLoginInput> {
  readonly method = "google";

  constructor(
    private readonly users: Pick<UsersPort, "findByEmail" | "createOwner" | "linkGoogleAccount">,
    private readonly verifier: GoogleIdentityVerifier | null,
    private readonly staffPolicy: StaffPolicy,
  ) {}

  async authenticate({ idToken }: GoogleLoginInput): Promise<LoginResult> {
    if (!this.verifier) throw new GoogleLoginDisabledError();

    let identity: GoogleIdentity;
    try {
      identity = await this.verifier.verify(idToken);
    } catch {
      throw new InvalidGoogleTokenError();
    }
    if (!identity.emailVerified) throw new InvalidGoogleTokenError();
    const staff = this.staffPolicy.isStaffGoogleLogin(identity);

    const existing = await this.users.findByEmail(identity.email);
    if (existing) {
      if (existing.googleId !== identity.sub) await this.users.linkGoogleAccount(existing.id, identity.sub);
      return { user: { ...existing, googleId: identity.sub }, created: false, staff };
    }

    const user = await this.users.createOwner({
      email: identity.email,
      name: identity.name ?? identity.email.split("@")[0] ?? identity.email,
      googleId: identity.sub,
      legacyPasswordHash: LegacyPasswordHash.unusable(),
    });
    return { user, created: true, staff };
  }
}
