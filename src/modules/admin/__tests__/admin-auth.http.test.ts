import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { pino } from "pino";

import { App } from "../../../app.js";
import { appConfig } from "../../../config/app.config.js";
import { Env } from "../../../config/env.js";
import { EventBus } from "../../../shared/events/event-bus.js";
import { AuthModule, authConfig } from "../../auth/index.js";
import { FakeGoogle, InMemoryCredentials, InMemoryRefreshTokens, InMemoryUsers } from "../../auth/__tests__/fakes.js";
import { TestBillingPort } from "../../billing/__tests__/fakes.js";
import { AdminModule } from "../admin.module.js";
import { adminConfig } from "../config/admin.config.js";
import { TestServiceControl } from "../../client-services/__tests__/fakes.js";
import { InMemorySubscriptions } from "../../subscriptions/__tests__/fakes.js";
import { InMemoryProfiles } from "../../profiles/__tests__/fakes.js";
import { InMemoryHotelNotifications } from "../../hotel-notifications/__tests__/fakes.js";
import { InMemoryClientArchive } from "../../client-archive/__tests__/fakes.js";
import { FakeClientAccounts, FakeMailbox, InMemoryAdmins, InMemoryAuditLog, InMemoryChallenges } from "./fakes.js";

// The real App, AdminModule and AuthModule over HTTP, with in-memory stores, a fake Google and a fake mailbox.

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

// fetch types json() as unknown; these tests inspect arbitrary response bodies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const idToken = (email: string, sub = `sub-${email}`, flag = "") => `google:${email}:${sub}${flag ? `:${flag}` : ""}`;

describe("admin login", () => {
  let base: string;
  let close: () => void;
  const admins = new InMemoryAdmins();
  const challenges = new InMemoryChallenges();
  const mailbox = new FakeMailbox();
  const users = new InMemoryUsers();
  const events: { name: string; reason?: string }[] = [];

  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string, token: string) => fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  const startLogin = async (email: string, sub?: string) =>
    (await json(await post("/api/v1/admin/auth/google", { idToken: idToken(email, sub) }))).data;
  const signIn = async (email: string) => {
    const { challengeId } = await startLogin(email);
    const res = await post("/api/v1/admin/auth/otp/verify", { challengeId, code: mailbox.lastCode });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("ez_admin_rt="));
    assert.ok(cookie, "expected the admin refresh cookie");
    return { data: (await json(res)).data, cookie: cookie.split(";")[0] as string, rawCookie: cookie };
  };

  before(async () => {
    const env = {
      NODE_ENV: "test",
      RATE_LIMIT_MAX: "0",
      AUTH_JWT_PRIVATE_KEY: Buffer.from(String(privateKey)).toString("base64"),
      AUTH_JWT_KEY_ID: "test-1",
      AUTH_COOKIE_SECURE: "false",
      AUTH_BCRYPT_ROUNDS: "10",
      AUTH_LOGIN_MAX_ATTEMPTS: "1000",
    };
    const config = Env.validate({ app: appConfig, auth: authConfig, admin: adminConfig }, env);
    const logger = pino({ level: "silent" });
    const bus = new EventBus(logger);
    bus.on("admin.login_denied", (event) => {
      events.push({ name: "denied", reason: event.reason });
    });
    bus.on("admin.logged_in", () => {
      events.push({ name: "logged_in" });
    });
    const refreshTokens = new InMemoryRefreshTokens();
    const google = new FakeGoogle();
    const auth = new AuthModule({
      config: config.auth,
      logger,
      events: bus,
      users,
      overrides: { credentials: new InMemoryCredentials(), refreshTokens, google },
    });
    const admin = new AdminModule({
      config: config.admin,
      authConfig: config.auth,
      logger,
      events: bus,
      mailer: mailbox,
      profiles: new InMemoryProfiles(),
      users,
      serviceControl: TestServiceControl.create().control,
      subscriptions: new InMemorySubscriptions(),
      clientAccounts: new FakeClientAccounts(),
      clientArchive: new InMemoryClientArchive(),
      hotelNotifications: new InMemoryHotelNotifications(),
      billing: TestBillingPort.create().port,
      overrides: { admins, challenges, auditLog: new InMemoryAuditLog(), refreshTokens, google },
    });
    const server = new App({ config: config.app, logger, modules: [auth, admin] }).express.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();

    admins.add({ email: "boss@eazotel.com", role: "super_admin", name: "Boss" });
    admins.add({ email: "staff@eazotel.com", advancedPermissions: ["credits.manage"] });
    admins.add({ email: "gone@eazotel.com", status: "disabled" });
    admins.add({ email: "linked@eazotel.com", googleId: "the-real-sub" });
  });
  after(() => close());
  beforeEach(() => {
    mailbox.failing = false;
    events.length = 0;
  });

  describe("step 1: Google", () => {
    it("emails a code to a listed admin and gives no session yet", async () => {
      const sentBefore = mailbox.sent.length;
      const res = await post("/api/v1/admin/auth/google", { idToken: idToken("boss@eazotel.com") });
      assert.equal(res.status, 200);
      const { data } = await json(res);
      assert.equal(data.email, "bo***@eazotel.com");
      assert.equal(data.accessToken, undefined);
      assert.equal(res.headers.getSetCookie().length, 0);
      assert.equal(mailbox.sent.length, sentBefore + 1);
      assert.equal(mailbox.sent.at(-1)?.to, "boss@eazotel.com");
    });

    it("refuses an unknown email: no email, no hotel account, nothing created", async () => {
      const mails = mailbox.sent.length;
      const res = await post("/api/v1/admin/auth/google", { idToken: idToken("stranger@eazotel.com") });
      assert.equal(res.status, 403);
      assert.equal((await json(res)).error.code, "ADMIN_NOT_ALLOWED");
      assert.equal(mailbox.sent.length, mails);
      assert.equal(users.records.size, 0, "a staff login must never create a Zucks_users account");
      assert.equal(await admins.findByEmail("stranger@eazotel.com"), null);
    });

    it("refuses disabled admins and a different Google account with the same answer", async () => {
      for (const [email, sub] of [
        ["gone@eazotel.com", undefined],
        ["linked@eazotel.com", "someone-else"],
      ] as const) {
        const res = await post("/api/v1/admin/auth/google", { idToken: idToken(email, sub) });
        assert.equal(res.status, 403);
        assert.equal((await json(res)).error.code, "ADMIN_NOT_ALLOWED");
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        events.map((e) => e.reason),
        ["disabled", "google_mismatch"],
      );
    });

    it("refuses a bad or unverified Google token", async () => {
      for (const token of ["not-a-real-google-token-at-all", idToken("boss@eazotel.com", "s", "unverified")]) {
        const res = await post("/api/v1/admin/auth/google", { idToken: token });
        assert.equal(res.status, 401);
        assert.equal((await json(res)).error.code, "GOOGLE_TOKEN_INVALID");
      }
    });

    it("leaves nothing behind when the email cannot be sent", async () => {
      const count = challenges.rows.size;
      mailbox.failing = true;
      const res = await post("/api/v1/admin/auth/google", { idToken: idToken("boss@eazotel.com") });
      assert.equal(res.status, 503);
      assert.equal((await json(res)).error.code, "OTP_SEND_FAILED");
      assert.equal(challenges.rows.size, count);
    });
  });

  describe("step 2: email code", () => {
    it("the right code starts a session with the right profile, and links the Google account", async () => {
      const { data, rawCookie } = await signIn("boss@eazotel.com");
      assert.ok(data.accessToken.length > 20);
      assert.equal(data.admin.role, "super_admin");
      assert.equal(data.admin.allProperties, true);
      assert.ok(data.admin.permissions.includes("subscriptions.manage"));
      assert.match(rawCookie, /HttpOnly/i);
      assert.match(rawCookie, /Path=\/api\/v1\/admin\/auth/);
      const saved = await admins.findByEmail("boss@eazotel.com");
      assert.equal(saved?.googleId, "sub-boss@eazotel.com");
      assert.ok(saved?.lastLoginAt);
    });

    it("an admin gets base permissions plus only the advanced ones given to them", async () => {
      const { data } = await signIn("staff@eazotel.com");
      assert.equal(data.admin.allProperties, false);
      assert.ok(data.admin.permissions.includes("clients.edit"));
      assert.ok(data.admin.permissions.includes("credits.manage"));
      assert.ok(!data.admin.permissions.includes("subscriptions.manage"));
    });

    it("a code works only once", async () => {
      const { challengeId } = await startLogin("boss@eazotel.com");
      const code = mailbox.lastCode;
      assert.equal((await post("/api/v1/admin/auth/otp/verify", { challengeId, code })).status, 200);
      const again = await post("/api/v1/admin/auth/otp/verify", { challengeId, code });
      assert.equal(again.status, 400);
      assert.equal((await json(again)).error.code, "OTP_EXPIRED");
    });

    it("a wrong code says how many attempts are left, and the limit ends the login", async () => {
      const { challengeId } = await startLogin("boss@eazotel.com");
      const right = mailbox.lastCode;
      const wrong = right === "000000" ? "000001" : "000000";
      for (const left of [4, 3, 2, 1]) {
        const res = await post("/api/v1/admin/auth/otp/verify", { challengeId, code: wrong });
        assert.equal(res.status, 401);
        const { error } = await json(res);
        assert.equal(error.code, "OTP_INVALID");
        assert.match(error.message, new RegExp(`${left} attempts left`));
      }
      const fifth = await post("/api/v1/admin/auth/otp/verify", { challengeId, code: wrong });
      assert.equal((await json(fifth)).error.code, "OTP_ATTEMPTS_EXCEEDED");
      const withRightCode = await post("/api/v1/admin/auth/otp/verify", { challengeId, code: right });
      assert.equal(withRightCode.status, 429, "even the right code is refused after the limit");
    });

    it("an expired code is refused", async () => {
      const { challengeId } = await startLogin("boss@eazotel.com");
      const code = mailbox.lastCode;
      const row = challenges.rows.get(challengeId);
      assert.ok(row);
      row.expiresAt = new Date(Date.now() - 1000);
      const res = await post("/api/v1/admin/auth/otp/verify", { challengeId, code });
      assert.equal((await json(res)).error.code, "OTP_EXPIRED");
    });

    it("rejects malformed codes before touching the attempt count", async () => {
      const { challengeId } = await startLogin("boss@eazotel.com");
      const res = await post("/api/v1/admin/auth/otp/verify", { challengeId, code: "12ab" });
      assert.equal(res.status, 400);
      assert.equal(challenges.rows.get(challengeId)?.attempts, 0);
    });

    it("access removed while the code was on its way stops the login", async () => {
      const staff = admins.add({ email: "leaving@eazotel.com" });
      const { challengeId } = await startLogin("leaving@eazotel.com");
      admins.rows.set(staff.id, { ...staff, status: "disabled" });
      const res = await post("/api/v1/admin/auth/otp/verify", { challengeId, code: mailbox.lastCode });
      assert.equal(res.status, 403);
    });
  });

  describe("resending a code", () => {
    it("must wait, then the new code works and the old one does not, and wrong attempts still count", async () => {
      const { challengeId } = await startLogin("boss@eazotel.com");
      const first = mailbox.lastCode;

      const tooSoon = await post("/api/v1/admin/auth/otp/resend", { challengeId });
      assert.equal(tooSoon.status, 429);
      assert.equal((await json(tooSoon)).error.code, "OTP_RESEND_UNAVAILABLE");

      const wrong = first === "000000" ? "000001" : "000000";
      await post("/api/v1/admin/auth/otp/verify", { challengeId, code: wrong });

      const row = challenges.rows.get(challengeId);
      assert.ok(row);
      row.lastSentAt = new Date(Date.now() - 61_000);
      assert.equal((await post("/api/v1/admin/auth/otp/resend", { challengeId })).status, 200);
      const second = mailbox.lastCode;
      assert.equal(challenges.rows.get(challengeId)?.attempts, 1, "a resend does not give more guesses");

      if (first !== second) {
        const old = await post("/api/v1/admin/auth/otp/verify", { challengeId, code: first });
        assert.equal((await json(old)).error.code, "OTP_INVALID");
      }
      assert.equal((await post("/api/v1/admin/auth/otp/verify", { challengeId, code: second })).status, 200);
    });

    it("stops after the email limit", async () => {
      const { challengeId } = await startLogin("boss@eazotel.com");
      const row = challenges.rows.get(challengeId);
      assert.ok(row);
      for (const status of [200, 200, 200, 429]) {
        row.lastSentAt = new Date(Date.now() - 61_000);
        assert.equal((await post("/api/v1/admin/auth/otp/resend", { challengeId })).status, status);
      }
    });
  });

  describe("session", () => {
    it("/me works with an admin token and shows the current profile", async () => {
      const { data } = await signIn("staff@eazotel.com");
      const res = await get("/api/v1/admin/auth/me", data.accessToken);
      assert.equal(res.status, 200);
      assert.equal((await json(res)).data.email, "staff@eazotel.com");
    });

    it("the access token holds no role or permissions", async () => {
      const { data } = await signIn("boss@eazotel.com");
      const payload = JSON.parse(Buffer.from(data.accessToken.split(".")[1], "base64url").toString());
      assert.deepEqual(Object.keys(payload).sort(), ["aud", "exp", "iat", "iss", "jti", "sid", "sub", "typ"]);
      assert.equal(payload.aud, "eazotel-admin");
    });

    it("disabling someone stops their very next request and their refresh", async () => {
      const staff = admins.add({ email: "fired@eazotel.com" });
      const { data, cookie } = await signIn("fired@eazotel.com");
      assert.equal((await get("/api/v1/admin/auth/me", data.accessToken)).status, 200);
      const current = admins.rows.get(staff.id);
      assert.ok(current);
      admins.rows.set(staff.id, { ...current, status: "disabled" });
      assert.equal((await get("/api/v1/admin/auth/me", data.accessToken)).status, 403);
      assert.equal((await post("/api/v1/admin/auth/refresh", {}, { cookie })).status, 403);
    });

    it("refresh rotates the cookie without a new code; logout ends the session", async () => {
      const { cookie } = await signIn("boss@eazotel.com");
      const mails = mailbox.sent.length;
      const refreshed = await post("/api/v1/admin/auth/refresh", {}, { cookie });
      assert.equal(refreshed.status, 200);
      assert.equal(mailbox.sent.length, mails);
      const next = refreshed.headers
        .getSetCookie()
        .find((c) => c.startsWith("ez_admin_rt="))
        ?.split(";")[0];
      assert.ok(next && next !== cookie);
      assert.equal((await post("/api/v1/admin/auth/logout", {}, { cookie: next })).status, 204);
      assert.equal((await post("/api/v1/admin/auth/refresh", {}, { cookie: next })).status, 401);
    });
  });

  describe("kept apart from hotel accounts", () => {
    it("a hotel token is refused on the admin API, even from a staff domain", async () => {
      const hotel = await json(await post("/api/v1/auth/google", { idToken: idToken("gm@sunrise-hotel.test") }));
      const staffDomain = await json(await post("/api/v1/auth/google", { idToken: idToken("boss@eazotel.com") }));
      for (const session of [hotel, staffDomain]) {
        const res = await get("/api/v1/admin/auth/me", session.data.accessToken);
        assert.equal(res.status, 401);
        assert.equal((await json(res)).error.code, "TOKEN_INVALID");
      }
    });

    it("an admin token is refused on the hotel API", async () => {
      const { data } = await signIn("boss@eazotel.com");
      const res = await get("/api/v1/auth/me", data.accessToken);
      assert.equal(res.status, 401);
      assert.equal((await json(res)).error.code, "TOKEN_INVALID");
    });

    it("an admin refresh cookie is refused by the hotel refresh route", async () => {
      const { cookie } = await signIn("boss@eazotel.com");
      const hotelCookie = cookie.replace("ez_admin_rt=", "ez_rt=");
      assert.equal((await post("/api/v1/auth/refresh", {}, { cookie: hotelCookie })).status, 401);
    });
  });
});
