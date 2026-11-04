import type { ClientPlatform } from "../../../shared/http/request-client.js";
import type { AuthContext } from "./auth-context.js";

export type LoginMethod = "password" | "google";

/** Where the request's identity came from: our RS256 access token, or an old nexon HS256 token. */
export type TokenSource = "access" | "legacy";

/** Permissions of the user on one property (from Zucks_users.assigned_location). */
export interface PropertyAccess {
  hid: string;
  perms: string[];
}

/** The staff member acting inside a client account (JWT `act` claim, RFC 8693). */
export interface Actor {
  sub: string;
  email: string;
}

/** Claims of an access token (besides iss, aud, iat, exp, jti). */
export interface AccessClaims {
  /** user id (Zucks_users _id) */
  sub: string;
  /** session id = refresh-token family; lets "log out other devices" keep this one */
  sid: string;
  ndid: string;
  email: string;
  role: string | null;
  admin: boolean;
  /** account-level permissions (accessScope flags that are true) */
  perms: string[];
  props: PropertyAccess[];
  /** Eazotel / Fielmente team member (verified Google login on a staff domain) */
  staff: boolean;
  /** present when a staff member switched into this account; the token then has no refresh token */
  act?: Actor;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export interface Session {
  sessionId: string;
  accessToken: IssuedToken;
  refreshToken: IssuedToken;
}

/** Who is calling, stored with refresh tokens so a user can see and end their sessions later. */
export interface ClientInfo {
  platform?: ClientPlatform;
  deviceId?: string;
  ip?: string;
  userAgent?: string;
}

// ── ports: implemented by the mongoose repositories, faked in tests ──────────

export interface StoredCredential {
  userId: string;
  passwordHash: string;
  /** nexon's accesskey at the time passwordHash was written (see CredentialService) */
  legacyHash: string | null;
}

export interface CredentialStore {
  findByUserId(userId: string): Promise<StoredCredential | null>;
  upsert(credential: StoredCredential): Promise<void>;
}

export type RevokeReason = "rotated" | "logout" | "reuse" | "password_changed" | "inactive";

export interface StoredRefreshToken {
  tokenHash: string;
  familyId: string;
  userId: string;
  audience: string;
  /** the login that started this family was a staff login; carried over on every rotation */
  staff: boolean;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: RevokeReason | null;
  replacedByHash: string | null;
}

export interface NewRefreshToken extends ClientInfo {
  tokenHash: string;
  familyId: string;
  userId: string;
  audience: string;
  staff: boolean;
  expiresAt: Date;
}

export interface RefreshTokenStore {
  create(token: NewRefreshToken): Promise<void>;
  findByHash(tokenHash: string): Promise<StoredRefreshToken | null>;
  /** Atomically marks an active token as rotated. False when it was no longer active (lost a race). */
  markRotated(tokenHash: string, replacedByHash: string): Promise<boolean>;
  revokeFamily(familyId: string, reason: RevokeReason): Promise<void>;
  revokeAllForUser(userId: string, reason: RevokeReason, exceptFamilyId?: string): Promise<void>;
}

/** A verified Google identity (structurally matches integrations/google). */
export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  /** Google Workspace domain of the account (`hd` claim), when it has one */
  hostedDomain: string | null;
}

export interface GoogleIdentityVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by AuthenticateMiddleware. Read it with AuthContext.of(req). */
      auth?: AuthContext;
    }
  }
}
