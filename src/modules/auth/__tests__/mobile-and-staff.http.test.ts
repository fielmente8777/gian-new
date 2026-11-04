import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { LegacyPasswordHash } from "../services/legacy-password-hash.js";
import { cookieOf, readJson, startApp } from "./test-app.js";

const ANDROID = { "x-client-platform": "android", "x-device-id": "pixel-8-abc123" };

describe("mobile app (X-Client-Platform: android)", () => {
  let app: Awaited<ReturnType<typeof startApp>>;

  before(async () => {
    app = await startApp();
    app.users.add({ email: "owner@hotel.test" }, LegacyPasswordHash.of("app-pass"));
  });
  after(() => app.close());

  it("login returns the refresh token in the body and sets no cookie", async () => {
    const res = await app.post("/api/v1/auth/login", { email: "owner@hotel.test", password: "app-pass" }, ANDROID);
    assert.equal(res.status, 200);
    assert.equal(cookieOf(res), undefined);
    const { data } = await readJson(res);
    assert.ok(data.refreshToken.length > 20);
    assert.ok(Date.parse(data.refreshTokenExpiresAt) > Date.now());
  });

  it("refresh and logout take the token from the body; a replayed token kills the session", async () => {
    const login = (
      await readJson(app.post("/api/v1/auth/login", { email: "owner@hotel.test", password: "app-pass" }, ANDROID))
    ).data;

    const refreshed = await app.post("/api/v1/auth/refresh", { refreshToken: login.refreshToken }, ANDROID);
    assert.equal(refreshed.status, 200);
    assert.equal(cookieOf(refreshed), undefined);
    const next = (await readJson(refreshed)).data.refreshToken;
    assert.notEqual(next, login.refreshToken);

    assert.equal((await app.post("/api/v1/auth/logout", { refreshToken: next }, ANDROID)).status, 204);
    assert.equal((await app.post("/api/v1/auth/refresh", { refreshToken: next }, ANDROID)).status, 401);
  });

  it("stores the platform and device with the session", async () => {
    app.refreshTokens.clients.clear();
    await app.post("/api/v1/auth/login", { email: "owner@hotel.test", password: "app-pass" }, ANDROID);
    assert.deepEqual([...app.refreshTokens.clients.values()], [{ platform: "android", deviceId: "pixel-8-abc123" }]);
  });

  it("an old nexon token (what the current app has) still works on the new API", async () => {
    const res = await app.get("/api/v1/auth/me", await app.legacy.sign("owner@hotel.test"));
    assert.equal(res.status, 200);
  });
});

describe("staff (Eazotel + Fielmente team)", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let client: { email: string; ndid: string | null };
  const audit: unknown[] = [];

  before(async () => {
    app = await startApp();
    app.events.on("user.account_switched", (event) => {
      audit.push(event);
    });
    client = app.users.add({ email: "gm@sunrise-hotel.test", scopes: ["cms"] }, LegacyPasswordHash.of("client-pass"));
    app.users.add({ email: "dev@eazotel.com" }, LegacyPasswordHash.of("staff-pass"));
  });
  after(() => app.close());

  const googleLogin = async (email: string) =>
    (await readJson(app.post("/api/v1/auth/google", { idToken: `google:${email}:sub-${email}` }))).data;

  it("Google sign-in on @eazotel.com and @fielmente.com is staff; other domains are not", async () => {
    assert.equal((await googleLogin("dev@eazotel.com")).isStaff, true);
    assert.equal((await googleLogin("ops@fielmente.com")).isStaff, true);
    assert.equal((await googleLogin("someone@gmail.com")).isStaff, false);
    assert.equal(decodeJwt((await googleLogin("ops@fielmente.com")).accessToken).staff, true);
  });

  it("a password login is never staff, even with a staff email", async () => {
    const { data } = await readJson(
      app.post("/api/v1/auth/login", { email: "dev@eazotel.com", password: "staff-pass" }),
    );
    assert.equal(data.isStaff, false);
    const res = await app.post(
      "/api/v1/auth/switch-account",
      { email: client.email },
      { authorization: `Bearer ${data.accessToken}` },
    );
    assert.equal(res.status, 403);
    assert.equal((await readJson(res)).error.code, "STAFF_ONLY");
  });

  it("staff switch into a client: short token for the client, naming the staff member, audited", async () => {
    const staff = await googleLogin("ops@fielmente.com");
    const res = await app.post(
      "/api/v1/auth/switch-account",
      { ndid: client.ndid },
      { authorization: `Bearer ${staff.accessToken}` },
    );
    assert.equal(res.status, 200);
    const { data } = await readJson(res);
    assert.equal(data.user.email, client.email);
    assert.deepEqual(data.switchedBy, { email: "ops@fielmente.com" });
    assert.equal("refreshToken" in data, false);

    const claims = decodeJwt(data.accessToken);
    assert.equal(claims.ndid, client.ndid);
    assert.equal(claims.staff, false);
    assert.equal((claims.act as { email: string }).email, "ops@fielmente.com");
    assert.ok(Number(claims.exp) - Number(claims.iat) === 3600);

    const me = await readJson(app.get("/api/v1/auth/me", data.accessToken));
    assert.deepEqual(me.data.switchedBy, { email: "ops@fielmente.com" });
    assert.equal(me.data.isStaff, false);

    // cannot switch again from inside a client account
    const chained = await app.post(
      "/api/v1/auth/switch-account",
      { email: "dev@eazotel.com" },
      { authorization: `Bearer ${data.accessToken}` },
    );
    assert.equal(chained.status, 403);
    assert.ok(audit.length >= 1);
  });

  it("staff refresh keeps staff; unknown client → 404", async () => {
    const res = await app.post("/api/v1/auth/google", { idToken: "google:dev@eazotel.com:sub-dev" });
    const refreshed = await readJson(
      fetch(`${app.base}/api/v1/auth/refresh`, { method: "POST", headers: { cookie: cookieOf(res)!.split(";")[0]! } }),
    );
    assert.equal(refreshed.data.isStaff, true);
    const missing = await app.post(
      "/api/v1/auth/switch-account",
      { email: "nobody@nowhere.test" },
      { authorization: `Bearer ${refreshed.data.accessToken}` },
    );
    assert.equal(missing.status, 404);
  });

  describe("old dashboard path POST /admin/switch-account (nexon signed any body for anyone)", () => {
    it("rejects callers without a token, and non-staff tokens", async () => {
      assert.equal((await app.post("/admin/switch-account", { Email: client.email })).status, 401);
      const clientToken = await app.legacy.sign(client.email);
      const res = await app.post(
        "/admin/switch-account",
        { Email: "dev@eazotel.com" },
        { authorization: `Bearer ${clientToken}` },
      );
      assert.equal(res.status, 403);
      assert.equal((await readJson(res)).Status, false);
    });

    it("staff with an old token (staff domain + Google-linked account) get a 1-hour nexon token for the client", async () => {
      app.users.add({ email: "lead@eazotel.com", googleId: "google-sub-lead" }, LegacyPasswordHash.of("x-pass"));
      const staffToken = await app.legacy.sign("lead@eazotel.com");
      const body = await readJson(
        app.post("/admin/switch-account", { Email: client.email }, { authorization: `Bearer ${staffToken}` }),
      );
      assert.equal(body.Status, true);
      const claims = decodeJwt(body.Token);
      assert.equal(claims.Email, client.email);
      assert.ok(Number(claims.exp) - Date.now() / 1000 <= 3600 + 5);
    });

    it("an old token on a staff domain that was never linked to Google is not staff", async () => {
      app.users.add({ email: "typed@eazotel.com" }, LegacyPasswordHash.of("y-pass"));
      const res = await app.post(
        "/admin/switch-account",
        { Email: client.email },
        { authorization: `Bearer ${await app.legacy.sign("typed@eazotel.com")}` },
      );
      assert.equal(res.status, 403);
    });
  });
});
