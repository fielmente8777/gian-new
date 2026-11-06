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

describe("staff (Eazotel + Fielmente team) on the hotel API", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let client: { email: string; ndid: string | null };

  before(async () => {
    app = await startApp();
    client = app.users.add({ email: "gm@sunrise-hotel.test", scopes: ["cms"] }, LegacyPasswordHash.of("client-pass"));
    app.users.add({ email: "dev@eazotel.com" }, LegacyPasswordHash.of("staff-pass"));
    app.users.add({ email: "lead@eazotel.com", googleId: "google-sub-lead" }, LegacyPasswordHash.of("x-pass"));
  });
  after(() => app.close());

  const googleLogin = async (email: string) =>
    (await readJson(app.post("/api/v1/auth/google", { idToken: `google:${email}:sub-${email}` }))).data;

  it("Google sign-in on @eazotel.com and @fielmente.com is flagged staff; other domains and password logins are not", async () => {
    assert.equal((await googleLogin("dev@eazotel.com")).isStaff, true);
    assert.equal((await googleLogin("someone@gmail.com")).isStaff, false);
    assert.equal(decodeJwt((await googleLogin("ops@fielmente.com")).accessToken).staff, true);
    const { data } = await readJson(
      app.post("/api/v1/auth/login", { email: "dev@eazotel.com", password: "staff-pass" }),
    );
    assert.equal(data.isStaff, false);
  });

  it("the staff flag no longer opens client accounts: /api/v1/auth/switch-account is gone", async () => {
    const staff = await googleLogin("ops@fielmente.com");
    const res = await app.post(
      "/api/v1/auth/switch-account",
      { ndid: client.ndid },
      { authorization: `Bearer ${staff.accessToken}` },
    );
    assert.equal(res.status, 404);
  });

  it("old dashboard path POST /admin/switch-account never returns a token, whoever asks", async () => {
    const callers: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${await app.legacy.sign(client.email)}` },
      // was accepted as staff before: staff domain + Google-linked account
      { authorization: `Bearer ${await app.legacy.sign("lead@eazotel.com")}` },
    ];
    for (const headers of callers) {
      const res = await app.post("/admin/switch-account", { Email: client.email }, headers);
      assert.equal(res.status, 403);
      const body = await readJson(res);
      assert.equal(body.Status, false);
      assert.equal(body.Token, undefined);
      assert.match(body.Message, /admin console/);
    }
  });
});

describe("ClientAccountTokens (what the admin console's Open account uses)", () => {
  it("signs a 1-hour nexon-style token for the account holder that the hotel API accepts", async () => {
    const app = await startApp();
    try {
      const owner = app.users.add({ email: "gm@sunrise-hotel.test" });
      const { token, expiresAt } = await app.clientAccountTokens.issue(owner.email);
      const claims = decodeJwt(token);
      assert.equal(claims.Email, owner.email);
      assert.ok(Math.abs(Number(claims.exp) * 1000 - expiresAt.getTime()) < 2000);
      assert.ok(expiresAt.getTime() - Date.now() <= 3_600_000 + 1000);
      const me = await readJson(app.get("/api/v1/auth/me", token));
      assert.equal(me.data.email, owner.email);
    } finally {
      app.close();
    }
  });
});
