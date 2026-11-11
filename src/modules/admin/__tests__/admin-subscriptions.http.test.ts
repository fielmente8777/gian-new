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
import { InMemoryProfiles } from "../../profiles/__tests__/fakes.js";
import { APPS, InMemorySubscriptions, PLANS } from "../../subscriptions/__tests__/fakes.js";
import { TestBillingPort } from "../../billing/__tests__/fakes.js";
import { TestReminders } from "../../renewal-reminders/__tests__/fakes.js";
import { AdminModule } from "../admin.module.js";
import { adminConfig } from "../config/admin.config.js";
import { AdminSubscriptionsService } from "../services/admin-subscriptions.service.js";
import type { AdminRecord } from "../types/admin.types.js";
import { InMemoryHotelNotifications } from "../../hotel-notifications/__tests__/fakes.js";
import { TestMetaPages } from "../../meta-pages/__tests__/fakes.js";
import { InMemoryClientArchive, InMemoryClientTrash } from "../../client-archive/__tests__/fakes.js";
import { FakeClientAccounts, FakeMailbox, InMemoryAdmins, InMemoryAuditLog, InMemoryChallenges } from "./fakes.js";

// The real App, AdminModule and ServiceEnforcer over HTTP, with in-memory stores.

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

// fetch types json() as unknown; these tests inspect arbitrary response bodies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const SUBS = "/api/v1/admin/subscriptions";
const DAY = 86_400_000;
const daysUntil = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / DAY);

describe("admin subscriptions", () => {
  let base: string;
  let close: () => void;
  let boss: AdminRecord;
  let staff: AdminRecord;
  const tokens = new Map<string, string>();
  const admins = new InMemoryAdmins();
  const auditLog = new InMemoryAuditLog();
  const mailbox = new FakeMailbox();
  const subscriptions = new InMemorySubscriptions();
  const { store, mailbox: digests, control } = TestServiceControl.create(subscriptions);

  const call = (method: string, path: string, who: AdminRecord, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.get(who.id)}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const signIn = async (admin: AdminRecord) => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}/api/v1/admin/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const { challengeId } = (await json(await post("/google", { idToken: `google:${admin.email}:sub-${admin.email}` })))
      .data;
    const res = await post("/otp/verify", { challengeId, code: mailbox.lastCode });
    tokens.set(admin.id, (await json(res)).data.accessToken);
  };

  before(async () => {
    const config = Env.validate(
      { app: appConfig, auth: authConfig, admin: adminConfig },
      {
        NODE_ENV: "test",
        RATE_LIMIT_MAX: "0",
        AUTH_JWT_PRIVATE_KEY: Buffer.from(String(privateKey)).toString("base64"),
        AUTH_JWT_KEY_ID: "test-1",
        AUTH_COOKIE_SECURE: "false",
        AUTH_BCRYPT_ROUNDS: "10",
        AUTH_LOGIN_MAX_ATTEMPTS: "1000",
      },
    );
    const logger = pino({ level: "silent" });
    const admin = new AdminModule({
      config: config.admin,
      authConfig: config.auth,
      logger,
      events: new EventBus(logger),
      mailer: mailbox,
      profiles: new InMemoryProfiles(),
      users: new InMemoryUsers(),
      clientAccounts: new FakeClientAccounts(),
      serviceControl: control,
      subscriptions,
      clientArchive: new InMemoryClientArchive(),
      clientTrash: new InMemoryClientTrash(),
      hotelNotifications: new InMemoryHotelNotifications(),
      billing: TestBillingPort.create().port,
      metaPages: TestMetaPages.create().port,
      reminders: TestReminders.create(subscriptions, mailbox).port,
      overrides: {
        admins,
        challenges: new InMemoryChallenges(),
        auditLog,
        refreshTokens: new InMemoryRefreshTokens(),
        google: new FakeGoogle(),
        testAccountsCacheMs: 0,
      },
    });
    const server = new App({ config: config.app, logger, modules: [admin] }).express.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();

    boss = admins.add({ email: "boss@eazotel.com", role: "super_admin" });
    staff = admins.add({ email: "staff@eazotel.com" });
    await signIn(boss);
    await signIn(staff);
  });
  after(() => close());
  beforeEach(async () => {
    subscriptions.rows.clear();
    store.switches.clear();
    store.alerts.length = 0;
    store.held.clear();
    store.chatbots.clear();
    digests.sent.length = 0;
    auditLog.rows.length = 0;
    subscriptions.add("aaa", "Amaltas Resort", 20);
    subscriptions.add("bbb", "Midori Hotel", 3);
    subscriptions.add("ccc", "Corbett The Grand", -10);
    store.chatbots.set("aaa", { active: true, paused: false });
    await admins.update(staff.id, { assignedProperties: [{ ndid: "aaa", hid: "h1" }], advancedPermissions: [] });
  });

  describe("seeing them", () => {
    it("lists every subscription with its state and the count per state, soonest end first", async () => {
      const { data } = await json(await call("GET", SUBS, boss));
      assert.deepEqual(
        data.items.map((s: { ndid: string; state: string }) => [s.ndid, s.state]),
        [
          ["ccc", "ended"],
          ["bbb", "ending"],
          ["aaa", "active"],
        ],
      );
      assert.deepEqual(data.counts, { all: 3, active: 1, ending: 1, ended: 1, stopped: 0 });
      assert.equal(data.total, 3);
    });

    it("filters by state (the counts stay for every state) and by hotel name", async () => {
      await call("POST", `${SUBS}/aaa/pause`, boss, {});
      const ended = (await json(await call("GET", `${SUBS}?state=stopped`, boss))).data;
      assert.deepEqual(
        ended.items.map((s: { ndid: string }) => s.ndid),
        ["aaa"],
      );
      assert.equal(ended.total, 1);
      assert.deepEqual(ended.counts, { all: 3, active: 0, ending: 1, ended: 1, stopped: 1 });
      const found = (await json(await call("GET", `${SUBS}?search=midori`, boss))).data;
      assert.equal(found.items[0].hotelName, "Midori Hotel");
      assert.equal(found.counts.all, 1);
    });

    it("sorts by hotel, plan or end date, both ways, and pages", async () => {
      const order = async (q: string) =>
        (await json(await call("GET", `${SUBS}?${q}`, boss))).data.items.map((s: { ndid: string }) => s.ndid);
      assert.deepEqual(await order("sort=hotel"), ["aaa", "ccc", "bbb"]);
      assert.deepEqual(await order("sort=hotel&order=desc"), ["bbb", "ccc", "aaa"]);
      assert.deepEqual(await order("sort=endDate&order=desc"), ["aaa", "bbb", "ccc"]);
      assert.deepEqual(await order("sort=state"), ["aaa", "bbb", "ccc"]);
      assert.deepEqual(await order("sort=hotel&pageSize=5&page=1"), ["aaa", "ccc", "bbb"]);
      assert.deepEqual(await order("sort=hotel&pageSize=5&page=2"), []);
      assert.equal((await call("GET", `${SUBS}?sort=price`, boss)).status, 400);
    });

    it("an admin sees only their clients' subscriptions", async () => {
      const { data } = await json(await call("GET", SUBS, staff));
      assert.deepEqual(
        data.items.map((s: { ndid: string }) => s.ndid),
        ["aaa"],
      );
      assert.equal((await call("GET", `${SUBS}/bbb`, staff)).status, 404);
    });

    it("lists the plans", async () => {
      const { data } = await json(await call("GET", "/api/v1/admin/plans", staff));
      assert.deepEqual(
        data.plans.map((p: { name: string }) => p.name),
        ["TRIAL", "BASIC", "PRO"],
      );
    });

    it("changing anything needs subscriptions.manage", async () => {
      for (const res of [
        await call("POST", `${SUBS}/aaa/pause`, staff, {}),
        await call("POST", `${SUBS}/aaa/renew`, staff, { months: 1 }),
        await call("POST", `${SUBS}/aaa/expire`, staff, {}),
        await call("PUT", `${SUBS}/aaa/plan`, staff, { planId: PLANS[2]!.id }),
      ]) {
        assert.equal(res.status, 403);
      }
    });
  });

  describe("pause and resume", () => {
    it("pause ends it now (the dashboard asks to renew), hides the chatbot, holds leads; resume gives the days back", async () => {
      const paused = (await json(await call("POST", `${SUBS}/aaa/pause`, boss, { reason: "unpaid invoice" }))).data;
      assert.equal(paused.state, "stopped");
      assert.ok(Date.parse(paused.subscription.endDate) <= Date.now(), "the dashboard's renew page shows");
      assert.equal(paused.subscription.staffStop.kind, "paused");
      assert.equal(paused.subscription.staffStop.daysLeftWhenPaused, 20);
      assert.equal(paused.services.chatbot, false);
      assert.equal(paused.services.leads, false);
      assert.equal(store.chatbots.get("aaa")?.paused, true);

      store.addAlert("aaa", "Asha");
      store.addAlert("aaa", "Ravi");
      const resumed = (await json(await call("POST", `${SUBS}/aaa/resume`, boss))).data;
      assert.equal(resumed.state, "active");
      assert.equal(daysUntil(resumed.subscription.endDate), 20);
      assert.equal(resumed.subscription.staffStop, null);
      assert.equal(store.chatbots.get("aaa")?.paused, false);
      assert.equal(resumed.emailed, 2);
      assert.equal(digests.sent.length, 1, "one email for both leads");
      assert.equal(auditLog.rows.at(-1)?.details?.emailedLeads, 2, "the log says how many were emailed");

      assert.deepEqual(
        auditLog.rows.map((r) => r.action),
        ["subscription.paused", "subscription.resumed"],
      );
      assert.equal(auditLog.rows[0]?.details?.reason, "unpaid invoice");
    });

    it("pausing twice keeps the first pause and logs once", async () => {
      await call("POST", `${SUBS}/aaa/pause`, boss, {});
      const again = (await json(await call("POST", `${SUBS}/aaa/pause`, boss, {}))).data;
      assert.equal(again.subscription.staffStop.daysLeftWhenPaused, 20);
      assert.equal(auditLog.rows.length, 1);
    });
  });

  describe("renew, expire, change plan", () => {
    it("renew adds months to the current end, or to today when it has ended", async () => {
      const a = (await json(await call("POST", `${SUBS}/aaa/renew`, boss, { months: 1, note: "UPI 123" }))).data;
      assert.ok(
        Math.abs(daysUntil(a.subscription.endDate) - 50) <= 1,
        `~20 + 30 days, got ${daysUntil(a.subscription.endDate)}`,
      );
      assert.equal(auditLog.rows.at(-1)?.details?.note, "UPI 123");

      const c = (await json(await call("POST", `${SUBS}/ccc/renew`, boss, { months: 12 }))).data;
      assert.ok(Math.abs(daysUntil(c.subscription.endDate) - 365) <= 1);
      assert.equal(c.subscription.status, "ACTIVE");
    });

    it("renew to an exact day, with an upgrade", async () => {
      const until = new Date(Date.now() + 100 * DAY).toISOString().slice(0, 10);
      const { data } = await json(await call("POST", `${SUBS}/bbb/renew`, boss, { until, planId: PLANS[2]!.id }));
      assert.equal(data.subscription.plan.name, "PRO");
      assert.ok(data.subscription.endDate.startsWith(until));
      assert.deepEqual(auditLog.rows.at(-1)?.changes?.plan, { from: "BASIC", to: "PRO" });
    });

    it("renewing a paused subscription gives its days back first, then adds", async () => {
      await call("POST", `${SUBS}/aaa/pause`, boss, {});
      const { data } = await json(await call("POST", `${SUBS}/aaa/renew`, boss, { months: 1 }));
      assert.ok(Math.abs(daysUntil(data.subscription.endDate) - 50) <= 1);
      assert.equal(data.subscription.staffStop, null);
      assert.equal(data.services.leads, true);
    });

    it("expire ends it now and keeps services off until renewed; the held leads go out on renew", async () => {
      const expired = (await json(await call("POST", `${SUBS}/aaa/expire`, boss, { reason: "left us" }))).data;
      assert.equal(expired.subscription.status, "EXPIRED");
      assert.equal(expired.subscription.staffStop.kind, "expired");
      assert.equal(expired.services.leads, false);

      store.addAlert("aaa", "Asha");
      const resumed = (await json(await call("POST", `${SUBS}/aaa/resume`, boss))).data;
      assert.equal(resumed.state, "stopped", "an expiry is not undone by resume");
      assert.equal(digests.sent.length, 0);

      const renewed = (await json(await call("POST", `${SUBS}/aaa/renew`, boss, { months: 3 }))).data;
      assert.equal(renewed.services.leads, true);
      assert.equal(renewed.emailed, 1);
    });

    it("change plan keeps the dates; an unknown plan is refused", async () => {
      const before = (await json(await call("GET", `${SUBS}/aaa`, boss))).data;
      const { data } = await json(await call("PUT", `${SUBS}/aaa/plan`, boss, { planId: PLANS[2]!.id }));
      assert.equal(data.subscription.plan.name, "PRO");
      assert.equal(data.subscription.endDate, before.subscription.endDate);

      const bad = await call("PUT", `${SUBS}/aaa/plan`, boss, { planId: "f".repeat(24) });
      assert.equal(bad.status, 400);
      assert.equal((await json(bad)).error.code, "PLAN_NOT_FOUND");
    });

    it("refuses a renew without months or until, both, or a past date; 404 without a subscription", async () => {
      assert.equal((await call("POST", `${SUBS}/aaa/renew`, boss, {})).status, 400);
      assert.equal((await call("POST", `${SUBS}/aaa/renew`, boss, { months: 1, until: "2099-01-01" })).status, 400);
      assert.equal((await call("POST", `${SUBS}/aaa/renew`, boss, { until: "2020-01-01" })).status, 400);
      const none = await call("POST", `${SUBS}/zzz/pause`, boss, {});
      assert.equal(none.status, 404);
      assert.equal((await json(none)).error.code, "SUBSCRIPTION_NOT_FOUND");
    });
  });

  describe("apps", () => {
    const day = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

    it("lists the app catalogue", async () => {
      const { data } = await json(await call("GET", "/api/v1/admin/apps", staff));
      assert.deepEqual(
        data.apps.map((a: { code: string }) => a.code),
        ["eazbot", "meta", "whatsapp"],
      );
    });

    it("sets exactly the apps a client has: listed ones on with their dates, the rest off, and logs it", async () => {
      const { data } = await json(
        await call("PUT", `${SUBS}/aaa/apps`, boss, {
          apps: [
            { appId: APPS[0]!.id, endDate: day(20) },
            { appId: APPS[1]!.id, endDate: day(5), isTrial: true },
          ],
        }),
      );
      assert.deepEqual(
        data.subscription.apps.map((a: { code: string; isTrial: boolean }) => [a.code, a.isTrial]),
        [
          ["eazbot", false],
          ["meta", true],
        ],
      );
      assert.ok(data.subscription.apps[0].endDate.startsWith(day(20)));
      assert.deepEqual(data.subscription.appAccess, { eazbot: true, meta: true, whatsapp: false });
      const entry = auditLog.rows.at(-1);
      assert.equal(entry?.action, "subscription.apps_changed");
      assert.match(String(entry?.changes?.apps?.to), /Eazbot until .*Meta Leads until .*\(trial\)/);
    });

    it("renew moves every app to the new end as paid, unless told not to", async () => {
      await call("PUT", `${SUBS}/aaa/apps`, boss, { apps: [{ appId: APPS[0]!.id, endDate: day(2), isTrial: true }] });
      const renewed = (await json(await call("POST", `${SUBS}/aaa/renew`, boss, { months: 1 }))).data;
      assert.equal(renewed.subscription.apps[0].endDate.slice(0, 10), renewed.subscription.endDate.slice(0, 10));
      assert.equal(renewed.subscription.apps[0].isTrial, false);

      await call("PUT", `${SUBS}/bbb/apps`, boss, { apps: [{ appId: APPS[0]!.id, endDate: day(2) }] });
      const kept = (await json(await call("POST", `${SUBS}/bbb/renew`, boss, { months: 1, extendApps: false }))).data;
      assert.ok(kept.subscription.apps[0].endDate.startsWith(day(2)));
    });

    it("pause or expire can also end every app; resume gives them the new end, renew extends them", async () => {
      await call("PUT", `${SUBS}/aaa/apps`, boss, {
        apps: [
          { appId: APPS[0]!.id, endDate: day(20) },
          { appId: APPS[1]!.id, endDate: day(20), isTrial: true },
        ],
      });
      const paused = (await json(await call("POST", `${SUBS}/aaa/pause`, boss, { endApps: true }))).data;
      assert.equal(paused.subscription.staffStop.appsEnded, true);
      assert.ok(paused.subscription.apps.every((a: { endDate: string }) => Date.parse(a.endDate) <= Date.now()));
      assert.equal(auditLog.rows.at(-1)?.details?.appsEnded, true);

      const resumed = (await json(await call("POST", `${SUBS}/aaa/resume`, boss))).data;
      for (const app of resumed.subscription.apps) {
        assert.equal(app.endDate.slice(0, 10), resumed.subscription.endDate.slice(0, 10));
      }
      assert.equal(resumed.subscription.apps[1].isTrial, true, "a trial stays a trial on resume");

      const plain = (await json(await call("POST", `${SUBS}/aaa/pause`, boss, {}))).data;
      assert.equal(plain.subscription.staffStop.appsEnded, false);
      assert.ok(
        plain.subscription.apps.every((a: { endDate: string }) => Date.parse(a.endDate) > Date.now()),
        "apps untouched by default",
      );
      await call("POST", `${SUBS}/aaa/resume`, boss);

      const expired = (await json(await call("POST", `${SUBS}/aaa/expire`, boss, { endApps: true }))).data;
      assert.ok(expired.subscription.apps.every((a: { endDate: string }) => Date.parse(a.endDate) <= Date.now()));
      const renewed = (await json(await call("POST", `${SUBS}/aaa/renew`, boss, { months: 1 }))).data;
      assert.ok(renewed.subscription.apps.every((a: { endDate: string }) => Date.parse(a.endDate) > Date.now()));
    });

    it("refuses an unknown app, an app twice, a bad date, and needs subscriptions.manage", async () => {
      const unknown = await call("PUT", `${SUBS}/aaa/apps`, boss, {
        apps: [{ appId: "f".repeat(24), endDate: day(5) }],
      });
      assert.equal(unknown.status, 400);
      assert.equal((await json(unknown)).error.code, "APP_NOT_FOUND");
      const twice = {
        apps: [
          { appId: APPS[0]!.id, endDate: day(5) },
          { appId: APPS[0]!.id, endDate: day(6) },
        ],
      };
      assert.equal((await call("PUT", `${SUBS}/aaa/apps`, boss, twice)).status, 400);
      assert.equal(
        (await call("PUT", `${SUBS}/aaa/apps`, boss, { apps: [{ appId: APPS[0]!.id, endDate: "soon" }] })).status,
        400,
      );
      assert.equal((await call("PUT", `${SUBS}/aaa/apps`, staff, { apps: [] })).status, 403);
    });
  });

  it("adding months never skips past the end of a short month", () => {
    assert.equal(
      AdminSubscriptionsService.addMonths(new Date("2026-01-31T10:00:00Z"), 1).toISOString().slice(0, 10),
      "2026-02-28",
    );
    assert.equal(
      AdminSubscriptionsService.addMonths(new Date("2026-03-15T10:00:00Z"), 12).toISOString().slice(0, 10),
      "2027-03-15",
    );
  });
});
