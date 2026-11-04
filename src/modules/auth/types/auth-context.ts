import type { Request } from "express";

import { UnauthorizedError } from "../../../shared/errors/http-errors.js";
import type { UserRecord } from "../../users/index.js";
import { AccountNotReadyError } from "../errors/auth.errors.js";
import type { AccessClaims, Actor, PropertyAccess, TokenSource } from "./auth.types.js";

interface AuthContextFields {
  userId: string;
  ndid: string;
  email: string;
  role: string | null;
  isAdmin: boolean;
  perms: readonly string[];
  props: readonly PropertyAccess[];
  isStaff: boolean;
  /** the staff member acting in this account (switch account), or null */
  actor: Actor | null;
  source: TokenSource;
  /** refresh-token family of this login; null for old nexon tokens and switched accounts */
  sessionId: string | null;
}

export interface SessionFlags {
  staff?: boolean;
  actor?: Actor | null;
}

/**
 * Who is making the request, set on `req.auth` by AuthenticateMiddleware. Services get
 * the tenant (ndid) and the property access from here, never from the request body.
 */
export class AuthContext implements AuthContextFields {
  readonly userId: string;
  readonly ndid: string;
  readonly email: string;
  readonly role: string | null;
  readonly isAdmin: boolean;
  readonly perms: readonly string[];
  readonly props: readonly PropertyAccess[];
  readonly isStaff: boolean;
  readonly actor: Actor | null;
  readonly source: TokenSource;
  readonly sessionId: string | null;

  constructor(fields: AuthContextFields) {
    this.userId = fields.userId;
    this.ndid = fields.ndid;
    this.email = fields.email;
    this.role = fields.role;
    this.isAdmin = fields.isAdmin;
    this.perms = Object.freeze([...fields.perms]);
    this.props = Object.freeze(fields.props.map((p) => Object.freeze({ hid: p.hid, perms: [...p.perms] })));
    this.isStaff = fields.isStaff;
    this.actor = fields.actor ? Object.freeze({ ...fields.actor }) : null;
    this.source = fields.source;
    this.sessionId = fields.sessionId;
    Object.freeze(this);
  }

  static fromUser(
    user: UserRecord,
    source: TokenSource,
    sessionId: string | null,
    flags: SessionFlags = {},
  ): AuthContext {
    if (!user.ndid) throw new AccountNotReadyError();
    return new AuthContext({
      userId: user.id,
      ndid: user.ndid,
      email: user.email,
      role: user.role,
      isAdmin: user.isAdmin,
      perms: user.scopes,
      props: user.locations.map((location) => ({ hid: location.hid, perms: location.scopes })),
      // a switched-into account is never staff, so switching cannot be chained
      isStaff: (flags.staff ?? false) && !flags.actor,
      actor: flags.actor ?? null,
      source,
      sessionId,
    });
  }

  static fromClaims(claims: AccessClaims): AuthContext {
    return new AuthContext({
      userId: claims.sub,
      ndid: claims.ndid,
      email: claims.email,
      role: claims.role,
      isAdmin: claims.admin,
      perms: claims.perms,
      props: claims.props,
      isStaff: claims.staff && !claims.act,
      actor: claims.act ?? null,
      source: "access",
      sessionId: claims.act ? null : claims.sid,
    });
  }

  /** The context of an authenticated request. Throws 401 on a route that forgot `authenticate`. */
  static of(req: Request): AuthContext {
    if (!req.auth) throw new UnauthorizedError();
    return req.auth;
  }

  /**
   * Whether the user has `permission`, on property `hid` when one is given.
   * - A property the user is assigned to: that property's permissions decide.
   * - Any other property: only an account admin (owner) has access, with the account permissions.
   *   Checking that `hid` belongs to this ndid is the properties module's job.
   * - No property: the account-level permissions decide.
   * Staff get no extra permissions here: to work in a client account they switch into it.
   */
  can(permission: string, hid?: string): boolean {
    if (hid === undefined) return this.perms.includes(permission);
    const property = this.props.find((p) => p.hid === hid);
    if (property) return property.perms.includes(permission);
    return this.isAdmin && this.perms.includes(permission);
  }

  toClaims(sessionId: string): AccessClaims {
    return {
      sub: this.userId,
      sid: sessionId,
      ndid: this.ndid,
      email: this.email,
      role: this.role,
      admin: this.isAdmin,
      perms: [...this.perms],
      props: this.props.map((p) => ({ hid: p.hid, perms: [...p.perms] })),
      staff: this.isStaff,
      ...(this.actor ? { act: { ...this.actor } } : {}),
    };
  }
}
