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
import { TestBillingPort } from "../../billing/__tests__/fakes.js";
import { InMemoryClientArchive, InMemoryClientTrash } from "../../client-archive/__tests__/fakes.js";
import { TestServiceControl } from "../../client-services/__tests__/fakes.js";
import { InMemoryHotelNotifications } from "../../hotel-notifications/__tests__/fakes.js";
import { TestMetaPages } from "../../meta-pages/__tests__/fakes.js";
import { InMemoryProfiles } from "../../profiles/__tests__/fakes.js";
import { TestReminders } from "../../renewal-reminders/__tests__/fakes.js";
import { InMemorySubscriptions } from "../../subscriptions/__tests__/fakes.js";
import { AdminModule } from "../admin.module.js";
import { adminConfig } from "../config/admin.config.js";
import type { AdminRecord } from "../types/admin.types.js";
import { FakeClientAccounts, FakeMailbox, InMemoryAdmins, InMemoryAuditLog, InMemoryChallenges } from "./fakes.js";

// The real App and AdminModule over HTTP, with a real reminder service over in-memory stores.

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const BASE = "/api/v1/admin/reminders";

describe("admin renewal reminders", () => {
  let base: string;
  let close: () => void;
  let boss: AdminRecord;
  let staff: AdminRecord;
  const tokens = new Map<string, string>();
  const admins = new InMemoryAdmins();
  const auditLog = new InMemoryAuditLog();
  const mailbox = new FakeMailbox();
  const subscriptions = new InMemorySubscriptions();
  const reminders = TestReminders.create(subscriptions, mailbox);

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
    tokens.set(
      admin.id,
      (await json(await post("/otp/verify", { challengeId, code: mailbox.lastCode }))).data.accessToken,
    );
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
    const admin = new AdminModule({
      config: config.admin,
      authConfig: config.auth,
      logger,
      events: new EventBus(logger),
      mailer: mailbox,
      profiles: new InMemoryProfiles(),
      users: new InMemoryUsers(),
      serviceControl: TestServiceControl.create(subscriptions).control,
      subscriptions,
      clientAccounts: new FakeClientAccounts(),
      clientArchive: new InMemoryClientArchive(),
      clientTrash: new InMemoryClientTrash(),
      hotelNotifications: new InMemoryHotelNotifications(),
      billing: TestBillingPort.create().port,
      metaPages: TestMetaPages.create().port,
      reminders: reminders.port,
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

    boss = admins.add({ email: "boss@eazotel.com", role: "super_admin" });
    staff = admins.add({ email: "staff@eazotel.com" });
    await signIn(boss);
    await signIn(staff);
  });
  after(() => close());
  beforeEach(async () => {
    subscriptions.rows.clear();
    reminders.log.rows.length = 0;
    auditLog.rows.length = 0;
    mailbox.sent.length = 0;
    subscriptions.add("aaa", "Amaltas Resort", 3);
    subscriptions.add("bbb", "Midori Hotel", -2);
    await admins.update(staff.id, { advancedPermissions: [], assignedProperties: [{ ndid: "aaa", hid: "11111111" }] });
  });

  it("starts switched off, and says whether email and WhatsApp can go out", async () => {
    const { data } = await json(await call("GET", BASE, boss));
    assert.equal(data.settings.enabled, false, "a deploy never starts messaging hotels by itself");
    assert.deepEqual(data.settings.daysBefore, [7, 3, 1]);
    assert.equal(data.emailReady, true);
    assert.equal(data.whatsappReady, true);
  });

  it("only billing.manage changes the schedule, and every change is logged", async () => {
    const { data: current } = await json(await call("GET", BASE, boss));
    const { updatedAt, updatedBy, ...input } = current.settings;
    void updatedAt;
    void updatedBy;
    const next = {
      ...input,
      enabled: true,
      renewUrl: "https://app.eazotel.com/plans",
      channels: { email: true, whatsapp: true },
    };

    await admins.update(staff.id, { advancedPermissions: ["billing.view"] });
    assert.equal((await call("PUT", `${BASE}/settings`, staff, next)).status, 403);

    const res = await call("PUT", `${BASE}/settings`, boss, next);
    assert.equal(res.status, 200);
    assert.equal((await json(res)).data.settings.enabled, true);
    const [entry] = auditLog.rows.filter((r) => r.action === "reminders.settings_updated");
    assert.deepEqual(entry?.changes?.enabled, { from: false, to: true });

    assert.equal((await call("PUT", `${BASE}/settings`, boss, { ...next, renewUrl: "http://plain.test" })).status, 400);
  });

  it("sends a reminder now, by email and WhatsApp, and shows it in the log", async () => {
    await reminders.port.saveSettings(
      { ...(await reminders.port.settings()), channels: { email: true, whatsapp: true } },
      "test",
    );
    const res = await call("POST", `${BASE}/send`, boss, { ndids: ["aaa", "bbb", "nobody"] });
    const { data } = await json(res);
    assert.equal(data.sent, 2);
    assert.equal(data.results.find((r: { ndid: string }) => r.ndid === "nobody").error, "SUBSCRIPTION_NOT_FOUND");
    assert.ok(mailbox.sent.some((m) => m.to === "aaa@hotel.test" && /ends in 3 days/.test(m.subject)));
    assert.ok(mailbox.sent.some((m) => m.to === "bbb@hotel.test" && /has ended/.test(m.subject)));
    assert.equal(reminders.whatsapp.sent.length, 2);
    assert.equal(auditLog.rows.filter((r) => r.action === "reminders.sent").length, 2);

    const log = (await json(await call("GET", `${BASE}/log`, boss))).data.items;
    assert.equal(log.length, 2);
    assert.equal(log[0].kind, "manual");
    assert.equal(log[0].by, "boss@eazotel.com");
  });

  it("an admin reminds and sees only their own clients", async () => {
    await admins.update(staff.id, { advancedPermissions: ["subscriptions.manage", "billing.view"] });
    const { data } = await json(await call("POST", `${BASE}/send`, staff, { ndids: ["aaa", "bbb"] }));
    assert.equal(data.sent, 1);
    assert.equal(data.results.find((r: { ndid: string }) => r.ndid === "bbb").error, "CLIENT_NOT_FOUND");
    await reminders.port.sendNow("bbb", "boss@eazotel.com");
    const log = (await json(await call("GET", `${BASE}/log`, staff))).data.items;
    assert.deepEqual(
      log.map((r: { ndid: string }) => r.ndid),
      ["aaa"],
    );
  });

  it("sending needs subscriptions.manage; seeing needs billing.view", async () => {
    assert.equal((await call("POST", `${BASE}/send`, staff, { ndids: ["aaa"] })).status, 403);
    assert.equal((await call("GET", BASE, staff)).status, 403);
    assert.equal((await call("GET", `${BASE}/upcoming`, staff)).status, 403);
  });
});
