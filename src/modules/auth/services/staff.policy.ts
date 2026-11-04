/**
 * Who counts as platform staff (Eazotel and Fielmente team).
 *
 * The email domain alone proves nothing: anyone can sign up with password and type
 * "someone@eazotel.com", and nexon even lets a hotel give its team members role "owner".
 * So staff = a Google sign-in whose email Google has verified, on a staff domain.
 * Password logins are never staff.
 */
export class StaffPolicy {
  private readonly domains: ReadonlySet<string>;

  constructor(domains: readonly string[]) {
    this.domains = new Set(domains.map((domain) => domain.toLowerCase()));
  }

  isStaffEmail(email: string): boolean {
    const domain = email.trim().toLowerCase().split("@")[1];
    return domain !== undefined && this.domains.has(domain);
  }

  /** For a fresh Google login: verified email on a staff domain. */
  isStaffGoogleLogin(identity: { email: string; emailVerified: boolean }): boolean {
    return identity.emailVerified && this.isStaffEmail(identity.email);
  }
}
