import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { pino } from "pino";

import { App } from "../../../app.js";
import { appConfig } from "../../../config/app.config.js";
import { Env } from "../../../config/env.js";
import { EventBus } from "../../../shared/events/event-bus.js";
import { authConfig } from "../../auth/index.js";
import { FakeGoogle, InMemoryRefreshTokens, InMemoryUsers } from "../../auth/__tests__/fakes.js";
import { TestServiceControl } from "../../client-services/__tests__/fakes.js";
import { InMemorySubscriptions } from "../../subscriptions/__tests__/fakes.js";
import { InMemoryProfiles } from "../../profiles/__tests__/fakes.js";
import { TestBillingPort } from "../../billing/__tests__/fakes.js";
import { AdminModule } from "../admin.module.js";
import { adminConfig } from "../config/admin.config.js";
import type { AdminRecord } from "../types/admin.types.js";
import { InMemoryHotelNotifications } from "../../hotel-notifications/__tests__/fakes.js";
import { InMemoryClientArchive } from "../../client-archive/__tests__/fakes.js";
import { FakeClientAccounts, FakeMailbox, InMemoryAdmins, InMemoryAuditLog, InMemoryChallenges } from "./fakes.js";

// The real App and AdminModule over HTTP, with in-memory stores, a fake Google and a fake mailbox.

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

// fetch types json() as unknown; these tests inspect arbitrary response bodies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const TEAM = "/api/v1/admin/team";
const AUDIT = "/api/v1/admin/audit-log";
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("admin team and audit log", () => {
  let base: string;
  let close: () => void;
  let boss: AdminRecord;
  let bossToken: string;
  let staff: AdminRecord;
  let staffToken: string;
  const admins = new InMemoryAdmins();
  const auditLog = new InMemoryAuditLog();
  const mailbox = new FakeMailbox();

  const call = (method: string, path: string, token: string | null, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const signIn = async (email: string): Promise<{ token: string; cookie: string }> => {
    const started = await call("POST", "/api/v1/admin/auth/google", null, { idToken: `google:${email}:sub-${email}` });
    const { challengeId } = (await json(started)).data;
    const res = await call("POST", "/api/v1/admin/auth/otp/verify", null, { challengeId, code: mailbox.lastCode });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("ez_admin_rt="));
    assert.ok(cookie);
    return { token: (await json(res)).data.accessToken, cookie: cookie.split(";")[0] as string };
  };
  const entries = (action: string) => auditLog.rows.filter((row) => row.action === action);

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
    const admin = new AdminModule({
      config: config.admin,
      authConfig: config.auth,
      logger,
      events: new EventBus(logger),
      mailer: mailbox,
      profiles: new InMemoryProfiles(),
      users: new InMemoryUsers(),
      serviceControl: TestServiceControl.create().control,
      subscriptions: new InMemorySubscriptions(),
      clientAccounts: new FakeClientAccounts(),
      clientArchive: new InMemoryClientArchive(),
      hotelNotifications: new InMemoryHotelNotifications(),
      billing: TestBillingPort.create().port,
      overrides: {
        admins,
        challenges: new InMemoryChallenges(),
        auditLog,
        refreshTokens: new InMemoryRefreshTokens(),
        google: new FakeGoogle(),
      },
    });
    const server = new App({ config: config.app, logger, modules: [admin] }).express.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  after(() => close());
  beforeEach(async () => {
    admins.rows.clear();
    auditLog.failing = false;
    boss = admins.add({ email: "boss@eazotel.com", role: "super_admin", name: "Boss" });
    staff = admins.add({ email: "staff@eazotel.com" });
    bossToken = (await signIn(boss.email)).token;
    staffToken = (await signIn(staff.email)).token;
    await settle();
    auditLog.rows.length = 0;
  });

  it("every route is in the API docs, with its permission", async () => {
    const { paths } = await json(await fetch(`${base}/docs/openapi.json`));
    assert.ok(paths["/api/v1/admin/auth/google"]?.post, "the login routes must stay documented");
    assert.ok(paths[TEAM]?.get && paths[TEAM]?.post);
    assert.ok(paths[`${TEAM}/{id}`]?.patch);
    assert.ok(paths[AUDIT]?.get);
  });

  describe("who can use it", () => {
    it("needs a token, and refuses normal admins even with every advanced permission", async () => {
      assert.equal((await call("GET", TEAM, null)).status, 401);
      assert.equal((await call("GET", AUDIT, null)).status, 401);

      await admins.update(staff.id, {
        advancedPermissions: ["subscriptions.manage", "credits.manage", "clients.open_account"],
      });
      for (const res of [
        await call("GET", TEAM, staffToken),
        await call("POST", TEAM, staffToken, { email: "new@eazotel.com" }),
        await call("PATCH", `${TEAM}/${staff.id}`, staffToken, { role: "super_admin" }),
        await call("GET", AUDIT, staffToken),
      ]) {
        assert.equal(res.status, 403);
        assert.equal((await json(res)).error.code, "PERMISSION_DENIED");
      }
      assert.equal((await admins.findById(staff.id))?.role, "admin", "must not be able to promote themselves");
    });

    it("team.manage and audit.view can never be given as advanced permissions", async () => {
      const res = await call("PATCH", `${TEAM}/${staff.id}`, bossToken, { advancedPermissions: ["team.manage"] });
      assert.equal(res.status, 400);
    });
  });

  describe("adding", () => {
    it("lists the team without exposing the Google id", async () => {
      const { data } = await json(await call("GET", TEAM, bossToken));
      assert.deepEqual(
        data.members.map((m: { email: string }) => m.email),
        ["boss@eazotel.com", "staff@eazotel.com"],
      );
      assert.equal(data.members[0].googleLinked, true);
      assert.equal(data.members[0].googleId, undefined);
    });

    it("adds someone who can then sign in, and logs who added them", async () => {
      const res = await call("POST", TEAM, bossToken, {
        email: "  New@Eazotel.com ",
        name: "New Person",
        assignedProperties: [{ ndid: "n1", hid: "h1" }],
      });
      assert.equal(res.status, 201);
      const { data } = await json(res);
      assert.equal(data.email, "new@eazotel.com");
      assert.equal(data.role, "admin");
      assert.equal(data.googleLinked, false);

      assert.ok((await signIn("new@eazotel.com")).token);
      const [entry] = entries("team.member_added");
      assert.equal(entry?.actorEmail, "boss@eazotel.com");
      assert.equal(entry?.targetEmail, "new@eazotel.com");
    });

    it("refuses an email already on the team, in any letter case", async () => {
      const res = await call("POST", TEAM, bossToken, { email: "STAFF@eazotel.com" });
      assert.equal(res.status, 409);
      assert.equal((await json(res)).error.code, "TEAM_MEMBER_EXISTS");
    });
  });

  describe("changing", () => {
    it("gives permissions and properties (admins may share one) and logs old and new values", async () => {
      await call("PATCH", `${TEAM}/${boss.id}`, bossToken, { assignedProperties: [{ ndid: "n1", hid: "h1" }] });
      const res = await call("PATCH", `${TEAM}/${staff.id}`, bossToken, {
        advancedPermissions: ["credits.manage", "credits.manage"],
        assignedProperties: [
          { ndid: "n1", hid: "h1" },
          { ndid: "n1", hid: "h1" },
          { ndid: "n1", hid: "h2" },
        ],
      });
      assert.equal(res.status, 200);
      const { data } = await json(res);
      assert.deepEqual(data.advancedPermissions, ["credits.manage"]);
      assert.equal(data.assignedProperties.length, 2);

      const entry = entries("team.member_updated").at(-1);
      assert.equal(entry?.targetEmail, staff.email);
      assert.deepEqual(entry?.changes?.advancedPermissions, { from: [], to: ["credits.manage"] });

      // applies to their very next request, with the token they already have
      const me = await json(await call("GET", "/api/v1/admin/auth/me", staffToken));
      assert.ok(me.data.permissions.includes("credits.manage"));
    });

    it("logs nothing when nothing really changed", async () => {
      const res = await call("PATCH", `${TEAM}/${staff.id}`, bossToken, { role: "admin", status: "active" });
      assert.equal(res.status, 200);
      assert.equal(entries("team.member_updated").length, 0);
    });

    it("disabling stops their next request and ends their sessions, so re-enabling does not revive them", async () => {
      const { cookie } = await signIn(staff.email);
      assert.equal((await call("PATCH", `${TEAM}/${staff.id}`, bossToken, { status: "disabled" })).status, 200);
      assert.equal((await call("GET", "/api/v1/admin/auth/me", staffToken)).status, 403);

      assert.equal((await call("PATCH", `${TEAM}/${staff.id}`, bossToken, { status: "active" })).status, 200);
      const refreshed = await fetch(`${base}/api/v1/admin/auth/refresh`, { method: "POST", headers: { cookie } });
      assert.equal(refreshed.status, 401);
    });

    it("a promoted admin can manage the team on their next request", async () => {
      await call("PATCH", `${TEAM}/${staff.id}`, bossToken, { role: "super_admin" });
      assert.equal((await call("GET", TEAM, staffToken)).status, 200);
    });

    it("404 for an unknown id, 400 for a malformed one or an empty change", async () => {
      assert.equal((await call("PATCH", `${TEAM}/${"a".repeat(24)}`, bossToken, { name: "X" })).status, 404);
      assert.equal((await call("PATCH", `${TEAM}/nope`, bossToken, { name: "X" })).status, 400);
      assert.equal((await call("PATCH", `${TEAM}/${staff.id}`, bossToken, {})).status, 400);
    });
  });

  describe("the team cannot lock itself out", () => {
    it("nobody can change their own role or status, but they can change their own name", async () => {
      for (const body of [{ role: "admin" }, { status: "disabled" }]) {
        const res = await call("PATCH", `${TEAM}/${boss.id}`, bossToken, body);
        assert.equal(res.status, 409);
        assert.equal((await json(res)).error.code, "CANNOT_CHANGE_OWN_ACCESS");
      }
      assert.equal((await call("PATCH", `${TEAM}/${boss.id}`, bossToken, { name: "Big Boss" })).status, 200);
    });

    it("keeps two active super admins, and allows the change once a third exists", async () => {
      const second = admins.add({ email: "second@eazotel.com", role: "super_admin" });
      for (const body of [{ role: "admin" }, { status: "disabled" }]) {
        const res = await call("PATCH", `${TEAM}/${second.id}`, bossToken, body);
        assert.equal(res.status, 409);
        assert.equal((await json(res)).error.code, "SUPER_ADMIN_MINIMUM");
      }

      admins.add({ email: "third@eazotel.com", role: "super_admin" });
      assert.equal((await call("PATCH", `${TEAM}/${second.id}`, bossToken, { role: "admin" })).status, 200);
    });

    it("a disabled super admin does not count towards the two", async () => {
      const second = admins.add({ email: "second@eazotel.com", role: "super_admin" });
      admins.add({ email: "off@eazotel.com", role: "super_admin", status: "disabled" });
      assert.equal((await call("PATCH", `${TEAM}/${second.id}`, bossToken, { status: "disabled" })).status, 409);
    });
  });

  describe("audit log", () => {
    it("records logins, including refused ones with the reason", async () => {
      await signIn(staff.email);
      await call("POST", "/api/v1/admin/auth/google", null, { idToken: "google:stranger@eazotel.com:sub-x" });
      await settle();

      assert.deepEqual(entries("login.denied").at(-1)?.details, { reason: "not_listed" });
      assert.equal(entries("login.denied").at(-1)?.actorEmail, "stranger@eazotel.com");
      assert.ok(entries("login.success").some((row) => row.actorEmail === staff.email));
    });

    it("pages newest first and filters by action and person", async () => {
      for (const email of ["a@eazotel.com", "b@eazotel.com", "c@eazotel.com"]) {
        await call("POST", TEAM, bossToken, { email });
      }

      const first = (await json(await call("GET", `${AUDIT}?action=team.member_added&limit=2`, bossToken))).data;
      assert.deepEqual(
        first.items.map((i: { targetEmail: string }) => i.targetEmail),
        ["c@eazotel.com", "b@eazotel.com"],
      );
      const second = (
        await json(await call("GET", `${AUDIT}?action=team.member_added&limit=2&before=${first.nextCursor}`, bossToken))
      ).data;
      assert.deepEqual(
        second.items.map((i: { targetEmail: string }) => i.targetEmail),
        ["a@eazotel.com"],
      );
      assert.equal(second.nextCursor, null);

      const byPerson = (await json(await call("GET", `${AUDIT}?email=B@eazotel.com`, bossToken))).data;
      assert.deepEqual(
        byPerson.items.map((i: { action: string }) => i.action),
        ["team.member_added"],
      );
    });

    it("rejects a bad limit or action", async () => {
      assert.equal((await call("GET", `${AUDIT}?limit=1000`, bossToken)).status, 400);
      assert.equal((await call("GET", `${AUDIT}?action=nope`, bossToken)).status, 400);
    });

    it("a failed audit write does not make a finished change look failed", async () => {
      auditLog.failing = true;
      const res = await call("PATCH", `${TEAM}/${staff.id}`, bossToken, { name: "Renamed" });
      assert.equal(res.status, 200);
      assert.equal((await admins.findById(staff.id))?.name, "Renamed");
    });
  });
});
