import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CookieOptions, Response } from "express";

import type { AuthConfig } from "../../auth/index.js";
import type { AdminConfig } from "../config/admin.config.js";
import { AdminRefreshCookie } from "../controllers/admin-refresh-cookie.js";

// The admin refresh cookie's attributes. "none" is for a console and API on different sites
// (admin.eazotel.com calling gian-new.onrender.com), where a lax cookie is never sent.

const written = (sameSite: AdminConfig["ADMIN_COOKIE_SAMESITE"] | undefined, secure: boolean) => {
  const auth = { AUTH_COOKIE_SECURE: secure, AUTH_COOKIE_DOMAIN: undefined } as unknown as AuthConfig;
  const admin = {
    ADMIN_REFRESH_COOKIE_NAME: "ez_admin_rt",
    ...(sameSite ? { ADMIN_COOKIE_SAMESITE: sameSite } : { ADMIN_COOKIE_SAMESITE: "lax" }),
  } as unknown as AdminConfig;
  let options: CookieOptions | undefined;
  const res = {
    cookie: (_name: string, _value: string, opts: CookieOptions) => {
      options = opts;
    },
  } as unknown as Response;
  new AdminRefreshCookie(auth, admin).write(res, { token: "t", expiresAt: new Date(Date.now() + 60_000) } as never);
  return options!;
};

describe("admin refresh cookie", () => {
  it("is lax by default, httpOnly, on the admin auth path only", () => {
    const o = written(undefined, true);
    assert.equal(o.sameSite, "lax");
    assert.equal(o.secure, true);
    assert.equal(o.httpOnly, true);
    assert.equal(o.path, "/api/v1/admin/auth");
  });

  it("can be sent across sites, and is then always Secure", () => {
    const o = written("none", false);
    assert.equal(o.sameSite, "none");
    assert.equal(o.secure, true);
  });
});
