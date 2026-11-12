import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { LegacyPasswordHash } from "../services/legacy-password-hash.js";
import { RefreshTokenService } from "../services/refresh-token.service.js";
import { cookieOf, cookieValue, readJson, startApp } from "./test-app.js";

describe("auth over HTTP", () => {
  let app: Awaited<ReturnType<typeof startApp>>;

  before(async () => {
    app = await startApp();
    app.users.add({ email: "Owner@Hotel.test", onboarding: true }, LegacyPasswordHash.of("nexon-pass"));
  });
  after(() => app.close());

  describe("new API /api/v1/auth", () => {
    it("login with a nexon password: access token in the body, refresh token only in an httpOnly cookie", async () => {
      const res = await app.post("/api/v1/auth/login", { email: "owner@hotel.test", password: "nexon-pass" });
      assert.equal(res.status, 200);
      const body = await readJson(res);
      assert.equal(body.success, true);
      assert.equal(body.data.tokenType, "Bearer");
      assert.equal(body.data.user.email, "Owner@Hotel.test");
      assert.equal("refreshToken" in body.data, false);
      assert.equal(JSON.stringify(body).includes("accesskey"), false);
      const cookie = cookieOf(res) ?? "";
      for (const part of ["HttpOnly", "Path=/api/v1/auth", "SameSite=Lax"])
        assert.ok(cookie.includes(part), `${part} in ${cookie}`);
    });

    it("wrong password → 401 INVALID_CREDENTIALS in the standard error envelope", async () => {
      const res = await app.post("/api/v1/auth/login", { email: "owner@hotel.test", password: "nope" });
      assert.equal(res.status, 401);
      const body = await readJson(res);
      assert.equal(body.success, false);
      assert.equal(body.error.code, "INVALID_CREDENTIALS");
      assert.equal(body.error.requestId, res.headers.get("x-request-id"));
    });

    it("invalid body → 400 VALIDATION_FAILED with field details", async () => {
      const res = await app.post("/api/v1/auth/login", { email: "not-an-email", password: "" });
      assert.equal(res.status, 400);
      const body = await readJson(res);
      assert.equal(body.error.code, "VALIDATION_FAILED");
      assert.deepEqual(body.error.details.map((d: { field: string }) => d.field).sort(), ["email", "password"]);
    });

    it("/me accepts our access token and an old nexon token, rejects none", async () => {
      const login = await readJson(
        app.post("/api/v1/auth/login", { email: "owner@hotel.test", password: "nexon-pass" }),
      );
      const withAccess = await fetch(`${app.base}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${login.data.accessToken}` },
      });
      assert.equal(withAccess.status, 200);
      assert.equal((await readJson(withAccess)).data.email, "Owner@Hotel.test");

      const nexonToken = await app.legacy.sign("Owner@Hotel.test");
      const withLegacy = await fetch(`${app.base}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${nexonToken}` },
      });
      assert.equal(withLegacy.status, 200);

      const without = await fetch(`${app.base}/api/v1/auth/me`);
      assert.equal(without.status, 401);
      assert.equal((await readJson(without)).error.code, "TOKEN_MISSING");
    });

    it("refresh rotates the cookie; an old cookie whose replacement was used later kills the session", async () => {
      const login = await app.post("/api/v1/auth/login", { email: "owner@hotel.test", password: "nexon-pass" });
      const first = cookieValue(cookieOf(login));

      const refreshed = await fetch(`${app.base}/api/v1/auth/refresh`, { method: "POST", headers: { cookie: first } });
      assert.equal(refreshed.status, 200);
      const second = cookieValue(cookieOf(refreshed));
      assert.notEqual(second, first);

      const used = await fetch(`${app.base}/api/v1/auth/refresh`, { method: "POST", headers: { cookie: second } });
      const third = cookieValue(cookieOf(used));

      app.refreshTokens.age(RefreshTokenService.hash(first.slice("ez_rt=".length)), 60_000);
      const replay = await fetch(`${app.base}/api/v1/auth/refresh`, { method: "POST", headers: { cookie: first } });
      assert.equal(replay.status, 401);
      assert.equal((await readJson(replay)).error.code, "REFRESH_TOKEN_REUSED");
      const afterTheft = await fetch(`${app.base}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { cookie: third },
      });
      assert.equal(afterTheft.status, 401);
    });

    it("register → 201 + session; same email again → 409 EMAIL_TAKEN (any letter case)", async () => {
      const res = await app.post("/api/v1/auth/register", {
        email: "new@hotel.test",
        password: "long-enough-1",
        name: "New Hotel",
      });
      assert.equal(res.status, 201);
      const again = await app.post("/api/v1/auth/register", {
        email: "NEW@hotel.test",
        password: "long-enough-1",
        name: "New Hotel",
      });
      assert.equal(again.status, 409);
      assert.equal((await readJson(again)).error.code, "EMAIL_TAKEN");
    });

    it("change password logs out other sessions but keeps this one", async () => {
      await app.post("/api/v1/auth/register", { email: "pw@hotel.test", password: "first-pass-1", name: "Pw" });
      const other = await app.post("/api/v1/auth/login", { email: "pw@hotel.test", password: "first-pass-1" });
      const mine = await app.post("/api/v1/auth/login", { email: "pw@hotel.test", password: "first-pass-1" });
      const token = (await readJson(mine)).data.accessToken;

      const res = await app.post(
        "/api/v1/auth/password",
        { currentPassword: "first-pass-1", newPassword: "second-pass-2" },
        { authorization: `Bearer ${token}` },
      );
      assert.equal(res.status, 204);

      const otherRefresh = await fetch(`${app.base}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { cookie: cookieValue(cookieOf(other)) },
      });
      assert.equal(otherRefresh.status, 401);
      const myRefresh = await fetch(`${app.base}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { cookie: cookieValue(cookieOf(mine)) },
      });
      assert.equal(myRefresh.status, 200);
      assert.equal(
        (await app.post("/api/v1/auth/login", { email: "pw@hotel.test", password: "second-pass-2" })).status,
        200,
      );
    });

    it("Google: unverified email refused; new email creates an owner (201)", async () => {
      assert.equal(
        (await app.post("/api/v1/auth/google", { idToken: "google:g1@hotel.test:sub-1:unverified" })).status,
        401,
      );
      const res = await app.post("/api/v1/auth/google", { idToken: "google:g1@hotel.test:sub-1" });
      assert.equal(res.status, 201);
      assert.equal((await app.post("/api/v1/auth/google", { idToken: "google:g1@hotel.test:sub-1" })).status, 200);
    });

    it("legacy exchange: a nexon token becomes a new session", async () => {
      const nexonToken = await app.legacy.sign("Owner@Hotel.test");
      const res = await app.post("/api/v1/auth/legacy/exchange", {}, { authorization: `Bearer ${nexonToken}` });
      assert.equal(res.status, 200);
      assert.ok(cookieOf(res));
    });
  });

  describe("old nexon paths (exact response shapes)", () => {
    it("POST /eazotel/ceateuser login", async () => {
      const ok = await readJson(
        app.post("/eazotel/ceateuser", { emailId: "owner@hotel.test", accesskey: "nexon-pass" }),
      );
      assert.deepEqual(Object.keys(ok).sort(), ["Message", "Status", "Token"]);
      assert.equal(ok.Status, true);
      assert.equal(ok.Message, "Login Successfully");
      assert.deepEqual(await app.legacy.verify(ok.Token), { email: "Owner@Hotel.test" });

      const bad = await app.post("/eazotel/ceateuser", { emailId: "owner@hotel.test", accesskey: "wrong" });
      assert.equal(bad.status, 200);
      assert.deepEqual(await readJson(bad), { Status: false, Message: "Invalid Combinations", Token: "-" });
      assert.deepEqual(await readJson(app.post("/eazotel/ceateuser", {})), { Status: false });
    });

    it('POST /eazotel/ceateuser register === "true"', async () => {
      const body = {
        register: "true",
        emailId: "legacy-new@hotel.test",
        accesskey: "pw",
        userName: "Legacy",
        hotelPhone: 9876543210,
      };
      const created = await readJson(app.post("/eazotel/ceateuser", body));
      assert.equal(created.Status, true);
      assert.equal(created.Message, "Registered Successfully");
      const user = await app.users.findByEmail("legacy-new@hotel.test");
      assert.equal(user?.phone, "9876543210");
      assert.equal(
        app.users.legacyHashes.get(user!.id),
        LegacyPasswordHash.of("pw"),
        "nexon can still log this user in",
      );
      assert.deepEqual(await readJson(app.post("/eazotel/ceateuser", body)), {
        Status: false,
        Message: "User Already Registered",
        Token: "-",
      });
    });

    it("POST /user/googleauth", async () => {
      const first = await readJson(
        app.post("/user/googleauth", {}, { authorization: "Bearer google:g2@hotel.test:sub-2" }),
      );
      assert.deepEqual(
        { ...first, token: typeof first.token },
        { status: true, message: "Registered Successfully", token: "string", onboarding: false },
      );
      const again = await readJson(
        app.post("/user/googleauth", {}, { authorization: "Bearer google:g2@hotel.test:sub-2" }),
      );
      assert.equal(again.message, "User logged in successfully");
      const missing = await app.post("/user/googleauth", {});
      assert.equal(missing.status, 500);
      assert.equal((await readJson(missing)).Status, false);
    });

    it("POST /eazotel/edit/password", async () => {
      app.users.add({ email: "edit@hotel.test" }, LegacyPasswordHash.of("before"));
      const token = await app.legacy.sign("edit@hotel.test");
      const wrong = await readJson(
        app.post("/eazotel/edit/password", { token, oldAccessId: "nope", newAccessId: "after" }),
      );
      assert.deepEqual(wrong, { Status: false, Message: "Invalid Combination" });
      const ok = await readJson(
        app.post("/eazotel/edit/password", { token, oldAccessId: "before", newAccessId: "after" }),
      );
      assert.deepEqual(ok, { Status: true, Message: "Password Changed Successfully" });
      assert.equal(
        (await readJson(app.post("/eazotel/ceateuser", { emailId: "edit@hotel.test", accesskey: "after" }))).Status,
        true,
      );
    });
  });

  it("/.well-known/jwks.json and unknown routes", async () => {
    const jwks = await fetch(`${app.base}/.well-known/jwks.json`);
    assert.equal(jwks.status, 200);
    assert.equal((await readJson(jwks)).keys[0].kid, "test-1");
    const missing = await fetch(`${app.base}/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await readJson(missing)).error.code, "ROUTE_NOT_FOUND");
  });

  it("CORS: /api/v1 only for listed origins (with cookies); legacy paths open like nexon", async () => {
    const preflight = (path: string, origin: string) =>
      fetch(app.base + path, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
    const allowed = await preflight("/api/v1/auth/login", "http://dashboard.test");
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://dashboard.test");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
    const denied = await preflight("/api/v1/auth/login", "http://evil.test");
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    const legacy = await preflight("/eazotel/ceateuser", "http://any-hotel.test");
    assert.equal(legacy.headers.get("access-control-allow-origin"), "*");
  });
});

describe("login rate limit", () => {
  it("blocks after AUTH_LOGIN_MAX_ATTEMPTS failures for that email; nexon paths answer in nexon shape", async () => {
    const app = await startApp({ AUTH_LOGIN_MAX_ATTEMPTS: "2" });
    try {
      for (let i = 0; i < 2; i++) await app.post("/api/v1/auth/login", { email: "x@hotel.test", password: "bad" });
      const blocked = await app.post("/api/v1/auth/login", { email: "x@hotel.test", password: "bad" });
      assert.equal(blocked.status, 429);
      assert.equal((await readJson(blocked)).error.code, "RATE_LIMITED");

      for (let i = 0; i < 2; i++) await app.post("/eazotel/ceateuser", { emailId: "y@hotel.test", accesskey: "bad" });
      const legacyBlocked = await app.post("/eazotel/ceateuser", { emailId: "y@hotel.test", accesskey: "bad" });
      assert.equal(legacyBlocked.status, 429);
      assert.equal((await readJson(legacyBlocked)).Status, false);
    } finally {
      app.close();
    }
  });
});
