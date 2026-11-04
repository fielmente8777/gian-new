import { OAuth2Client } from "google-auth-library";
import { z } from "zod";

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  /** Google Workspace domain (`hd`), e.g. "eazotel.com"; null for personal accounts */
  hostedDomain: string | null;
}

// the part of Google's ID-token payload we rely on, validated like any third-party response
const payloadSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(3),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  hd: z.string().optional(),
});

/**
 * Verifies a "Sign in with Google" ID token: signature against Google's keys, issuer,
 * expiry, and that it was issued to one of our OAuth client ids. Works for the web
 * button (dashboard) and for Android/iOS sign-in, whose ID token is issued to the web
 * client id given to the app as `serverClientId`.
 */
export class GoogleIdTokenVerifier {
  private readonly client = new OAuth2Client();

  constructor(private readonly clientIds: readonly string[]) {}

  /** Throws when the token is invalid, expired or for another client. */
  async verify(idToken: string): Promise<GoogleIdentity> {
    const ticket = await this.client.verifyIdToken({ idToken, audience: [...this.clientIds] });
    const payload = payloadSchema.parse(ticket.getPayload());
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
      hostedDomain: payload.hd?.toLowerCase() ?? null,
    };
  }
}
