import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { pino } from "pino";

import { App } from "../../../app.js";
import { appConfig } from "../../../config/app.config.js";
import { Env } from "../../../config/env.js";
import { EventBus } from "../../../shared/events/event-bus.js";
import { TestAiCredits } from "../../ai-credits/__tests__/fakes.js";
import { UtcDays } from "../../ai-credits/index.js";
import { authConfig } from "../../auth/index.js";
import { FakeGoogle, InMemoryRefreshTokens, InMemoryUsers } from "../../auth/__tests__/fakes.js";
import { TestBillingPort } from "../../billing/__tests__/fakes.js";
import { InMemoryClientArchive, InMemoryClientTrash } from "../../client-archive/__tests__/fakes.js";
import { TestServiceControl } from "../../client-services/__tests__/fakes.js";
import { InMemoryHotelNotifications } from "../../hotel-notifications/__tests__/fakes.js";
import { TestMetaPages } from "../../meta-pages/__tests__/fakes.js";
import { InMemoryProfiles } from "../../profiles/__tests__/fakes.js";
import { InMemorySubscriptions } from "../../subscriptions/__tests__/fakes.js";
import { TestReminders } from "../../renewal-reminders/__tests__/fakes.js";
import { AdminModule } from "../admin.module.js";
import { adminConfig } from "../config/admin.config.js";
import type { AdminRecord } from "../types/admin.types.js";
import { FakeClientAccounts, FakeMailbox, InMemoryAdmins, InMemoryAuditLog, InMemoryChallenges } from "./fakes.js";

// The real App and AdminModule over HTTP, with the real AiCreditsModule over in-memory stores.

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const AI = "/api/v1/admin/ai-credits";
const key = (n: number) => `test-key-${n}-0000`;

describe("admin AI credits", () => {
  let base: string;
  let close: () => void;
  let boss: AdminRecord;
  let viewer: AdminRecord;
  let manager: AdminRecord;
  let admin: AdminModule;
  const tokens = new Map<string, string>();
  const admins = new InMemoryAdmins();
  const profiles = new InMemoryProfiles();
  const auditLog = new InMemoryAuditLog();
  const subscriptions = new InMemorySubscriptions();
  const mailbox = new FakeMailbox();
  let ai = TestAiCredits.create();
  const port = { ...ai.port };

  const call = (method: string, path: string, who: AdminRecord, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.get(who.id)}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const signIn = async (who: AdminRecord) => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}/api/v1/admin/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const started = await post("/google", { idToken: `google:${who.email}:sub-${who.email}` });
    const { challengeId } = (await json(started)).data;
    const res = await post("/otp/verify", { challengeId, code: mailbox.lastCode });
    tokens.set(who.id, (await json(res)).data.accessToken);
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
    admin = new AdminModule({
      config: config.admin,
      authConfig: config.auth,
      logger,
      events: new EventBus(logger),
      mailer: mailbox,
      profiles,
      users: new InMemoryUsers(),
      serviceControl: TestServiceControl.create(subscriptions).control,
      subscriptions,
      clientAccounts: new FakeClientAccounts(),
      clientArchive: new InMemoryClientArchive(),
      clientTrash: new InMemoryClientTrash(),
      hotelNotifications: new InMemoryHotelNotifications(),
      billing: TestBillingPort.create().port,
      metaPages: TestMetaPages.create().port,
      reminders: TestReminders.create(subscriptions, mailbox).port,
      // each test gets fresh stores: the module keeps this object, beforeEach swaps its parts
      aiCredits: port,
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
    viewer = admins.add({ email: "viewer@eazotel.com", assignedProperties: [{ ndid: "corbett", hid: "26723586" }] });
    manager = admins.add({
      email: "manager@eazotel.com",
      advancedPermissions: ["credits.manage"],
      assignedProperties: [{ ndid: "corbett", hid: "26723586" }],
    });
    for (const who of [boss, viewer, manager]) await signIn(who);
  });
  after(() => close());
  beforeEach(() => {
    ai = TestAiCredits.create();
    Object.assign(port, ai.port);
    profiles.rows.clear();
    auditLog.rows.length = 0;
    profiles.add("corbett", "Corbett The Grand", [{ hid: "26723586" }]);
    profiles.add("midori", "Midori", [{ hid: "96210201" }]);
    ai.wallets.seed("corbett", 5000, 1000);
    ai.wallets.seed("midori", 200);
  });

  describe("who sees what", () => {
    it("every admin lists only their own clients; another client is 'not found'", async () => {
      const list = await json(await call("GET", `${AI}/clients`, viewer));
      assert.deepEqual(
        list.data.items.map((c: { ndid: string }) => c.ndid),
        ["corbett"],
      );
      assert.equal(list.data.items[0].wallet.available, 4000);
      assert.equal(list.data.items[0].level, "healthy");

      const other = await call("GET", `${AI}/clients/midori`, viewer);
      assert.equal(other.status, 404);
      assert.equal((await json(other)).error.code, "CLIENT_NOT_FOUND");

      const all = await json(await call("GET", `${AI}/clients`, boss));
      assert.equal(all.data.items.length, 2);
      assert.equal(all.data.items.find((c: { ndid: string }) => c.ndid === "midori").level, "critical");
    });

    it("company-wide screens need credits.pricing", async () => {
      for (const path of [
        "/overview",
        "/pricing",
        "/packages",
        "/settings",
        "/openai/topups",
        "/openai/costs",
        "/audit",
      ]) {
        const res = await call("GET", AI + path, manager);
        assert.equal(res.status, 403, path);
        assert.equal((await json(res)).error.code, "PERMISSION_DENIED");
      }
      assert.equal((await call("GET", `${AI}/overview`, boss)).status, 200);
    });

    it("changing credits needs credits.manage", async () => {
      const res = await call("POST", `${AI}/clients/corbett/adjust`, viewer, {
        direction: "add",
        amount: 10,
        reason: "goodwill",
        idempotencyKey: key(1),
      });
      assert.equal(res.status, 403);
    });
  });

  describe("adding and removing credits", () => {
    it("adds credits once per key, in gian's ledger, gian's audit and the console's activity log", async () => {
      const body = { direction: "add", amount: 500, reason: "Launch offer", idempotencyKey: key(2) };
      const first = await json(await call("POST", `${AI}/clients/corbett/adjust`, manager, body));
      assert.deepEqual(
        { before: first.data.balanceBefore, after: first.data.balanceAfter, replayed: first.data.replayed },
        { before: 5000, after: 5500, replayed: false },
      );
      const again = await json(await call("POST", `${AI}/clients/corbett/adjust`, manager, body));
      assert.equal(again.data.replayed, true);
      assert.equal((await ai.wallets.find("corbett")).balance, 5500, "a retried click adds nothing");

      assert.equal(ai.wallets.ledgerRows.length, 1);
      assert.equal(ai.wallets.ledgerRows[0]!.performedBy, "manager@eazotel.com");
      assert.deepEqual(
        ai.gianAudit.rows.map((r) => [r.action, r.actor, r.tenantId]),
        [["credits.add", "manager@eazotel.com", "corbett"]],
      );
      const logged = auditLog.rows.filter((r) => r.action === "credits.granted");
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.targetId, "corbett");
      assert.deepEqual(logged[0]!.changes, { balance: { from: 5000, to: 5500 } });

      const ledger = await json(await call("GET", `${AI}/clients/corbett/transactions`, viewer));
      assert.equal(ledger.data.items[0].amount, 500);
    });

    it("never deducts more than the available credits", async () => {
      // 5000 balance, 1000 held by running requests
      const res = await call("POST", `${AI}/clients/corbett/adjust`, manager, {
        direction: "deduct",
        amount: 4500,
        reason: "refund reversal",
        idempotencyKey: key(3),
      });
      assert.equal(res.status, 422);
      assert.equal((await json(res)).error.code, "AI_CREDITS_INSUFFICIENT");
      assert.equal((await ai.wallets.find("corbett")).balance, 5000);
      assert.equal(auditLog.rows.length, 0);
    });

    it("can't touch a client outside the admin's properties", async () => {
      const res = await call("POST", `${AI}/clients/midori/adjust`, manager, {
        direction: "add",
        amount: 10,
        reason: "goodwill",
        idempotencyKey: key(4),
      });
      assert.equal(res.status, 404);
      assert.equal((await ai.wallets.find("midori")).balance, 200);
    });

    it("suspends and resumes a client's AI, logged once per real change", async () => {
      const off = await json(
        await call("PUT", `${AI}/clients/corbett/status`, manager, { status: "suspended", reason: "unpaid invoice" }),
      );
      assert.equal(off.data.status, "suspended");
      await call("PUT", `${AI}/clients/corbett/status`, manager, { status: "suspended", reason: "unpaid invoice" });
      await call("PUT", `${AI}/clients/corbett/status`, manager, { status: "active", reason: "paid" });
      assert.deepEqual(
        auditLog.rows.map((r) => r.action),
        ["credits.wallet_suspended", "credits.wallet_resumed"],
      );
    });

    it("bulk grant: each client on its own, out-of-scope ones fail alone, the batch applies once", async () => {
      const body = {
        ndids: ["corbett", "midori", "ghost"],
        amount: 100,
        reason: "Diwali bonus",
        batchId: "batch-0001",
      };
      const res = await json(await call("POST", `${AI}/clients/bulk-grant`, manager, body));
      assert.deepEqual(
        res.data.results.map((r: { ndid: string; ok: boolean; error?: string }) => [r.ndid, r.ok, r.error ?? null]),
        [
          ["corbett", true, null],
          ["midori", false, "CLIENT_NOT_FOUND"],
          ["ghost", false, "CLIENT_NOT_FOUND"],
        ],
      );
      const again = await json(await call("POST", `${AI}/clients/bulk-grant`, manager, body));
      assert.equal(again.data.granted, 0);
      assert.equal((await ai.wallets.find("corbett")).balance, 5100);
      assert.equal(auditLog.rows.filter((r) => r.action === "credits.bulk_granted").length, 1);

      const all = await json(await call("POST", `${AI}/clients/bulk-grant`, boss, { ...body, batchId: "batch-0002" }));
      assert.equal(all.data.granted, 2);
    });
  });

  describe("pricing, packages, settings", () => {
    it("shows what a credit costs and the margin at package prices", async () => {
      await call("PUT", `${AI}/settings`, boss, { pool: { usdInrRate: 88 } });
      const created = await call("POST", `${AI}/pricing`, boss, {
        provider: "OpenAI",
        model: "gpt-5-mini",
        inputPrice: 0.25,
        outputPrice: 2,
        creditConversionRate: 1000,
      });
      assert.equal(created.status, 201);
      const row = (await json(created)).data;
      assert.equal(row.provider, "openai");
      assert.equal(row.currency, "USD");
      assert.equal(row.appliesWithinSeconds, 30);

      const dup = await call("POST", `${AI}/pricing`, boss, {
        provider: "openai",
        model: "gpt-5-mini",
        creditConversionRate: 5,
      });
      assert.equal(dup.status, 409);
      assert.equal((await json(dup)).error.code, "AI_PRICING_EXISTS");

      await call("POST", `${AI}/packages`, boss, { name: "Starter", credits: 2500, price: 499 });
      const list = await json(await call("GET", `${AI}/pricing`, boss));
      const view = list.data.items[0];
      assert.equal(view.costPerCreditUsd, 0.001);
      assert.equal(view.costPerCreditInr, 0.088);
      // sold at ₹0.1996 per credit, costs ₹0.088
      assert.equal(view.marginPct, 55.9);
      assert.deepEqual(list.data.salePerCreditInr, { min: 0.1996, max: 0.1996 });

      const changed = await json(await call("PATCH", `${AI}/pricing/${row.id}`, boss, { creditConversionRate: 1200 }));
      assert.equal(changed.data.creditConversionRate, 1200);
      const logged = auditLog.rows.filter((r) => r.action === "credits.pricing_changed");
      assert.equal(logged.length, 2);
      assert.deepEqual(logged[1]!.changes, { creditConversionRate: { from: 1000, to: 1200 } });
      assert.deepEqual(
        ai.gianAudit.rows.map((r) => r.action),
        ["pricing.create", "package.create", "pricing.update"],
      );
    });

    it("marking a package popular unmarks the others", async () => {
      const a = (
        await json(await call("POST", `${AI}/packages`, boss, { name: "A", credits: 100, price: 50, popular: true }))
      ).data;
      await call("POST", `${AI}/packages`, boss, { name: "B", credits: 200, price: 90, popular: true });
      const list = await json(await call("GET", `${AI}/packages`, boss));
      assert.deepEqual(
        list.data.map((p: { name: string; popular: boolean }) => [p.name, p.popular]),
        [
          ["A", false],
          ["B", true],
        ],
      );
      const missing = await call("PATCH", `${AI}/packages/${"f".repeat(24)}`, boss, { price: 1 });
      assert.equal(missing.status, 404);
      assert.ok(a.id);
    });

    it("keeps the critical level below the low level", async () => {
      const bad = await call("PUT", `${AI}/settings`, boss, { credits: { criticalThreshold: 2000 } });
      assert.equal(bad.status, 400);
      assert.equal((await json(bad)).error.code, "AI_THRESHOLDS_INVALID");

      const ok = await json(
        await call("PUT", `${AI}/settings`, boss, {
          credits: { lowThreshold: 2000, criticalThreshold: 500 },
          pool: { lowPoolUsd: 50, alertEmails: ["Finance@Eazotel.com"] },
        }),
      );
      assert.equal(ok.data.credits.lowThreshold, 2000);
      assert.deepEqual(ok.data.pool.alertEmails, ["finance@eazotel.com"]);
      const logged = auditLog.rows.find((r) => r.action === "credits.settings_changed");
      assert.deepEqual(Object.keys(logged!.changes ?? {}).sort(), [
        "credits.criticalThreshold",
        "credits.lowThreshold",
        "pool.alertEmails",
        "pool.lowPoolUsd",
      ]);
    });

    it("switches charging on and off, starting off", async () => {
      const start = await json(await call("GET", `${AI}/settings`, boss));
      assert.equal(start.data.credits.enabled, false);
      assert.equal((await json(await call("GET", `${AI}/overview`, boss))).data.chargingEnabled, false);

      const on = await json(await call("PUT", `${AI}/settings`, boss, { credits: { enabled: true } }));
      assert.equal(on.data.credits.enabled, true);
      assert.equal((await json(await call("GET", `${AI}/overview`, boss))).data.chargingEnabled, true);

      const bad = await call("PUT", `${AI}/settings`, boss, { credits: { enabled: "yes" } });
      assert.equal(bad.status, 400);
      const logged = auditLog.rows.filter((r) => r.action === "credits.settings_changed").at(-1);
      assert.deepEqual(Object.keys(logged!.changes ?? {}), ["credits.enabled"]);
    });
  });

  describe("the OpenAI account", () => {
    it("top-ups, sync and the overview add up", async () => {
      const today = UtcDays.of(new Date());
      const t1 = await call("POST", `${AI}/openai/topups`, boss, {
        amountUsd: 100,
        paidOn: UtcDays.add(today, -3),
        note: "opening balance",
      });
      assert.equal(t1.status, 201);
      ai.openai.add(UtcDays.add(today, -2), 4);
      ai.openai.add(UtcDays.add(today, -1), 6);

      const synced = await json(await call("POST", `${AI}/openai/sync`, boss));
      assert.equal(synced.data.ok, true);

      const overview = await json(await call("GET", `${AI}/overview`, boss));
      assert.equal(overview.data.openai.remainingUsd, 90);
      assert.equal(overview.data.openai.configured, true);
      assert.deepEqual(
        overview.data.lowWallets.map((w: { ndid: string; hotelName: string }) => [w.ndid, w.hotelName]),
        [["midori", "Midori"]],
      );

      const topUp = (await json(t1)).data;
      const fixed = await json(await call("PATCH", `${AI}/openai/topups/${topUp.id}`, boss, { amountUsd: 120 }));
      assert.equal(fixed.data.amountUsd, 120);
      assert.equal((await json(await call("GET", `${AI}/openai/topups`, boss))).data.totalUsd, 120);
      assert.deepEqual(
        auditLog.rows.map((r) => r.action),
        ["credits.openai_topup_added", "credits.openai_topup_edited"],
      );

      const costs = await json(await call("GET", `${AI}/openai/costs?days=7`, boss));
      assert.equal(costs.data.days.length, 7);
      assert.equal(costs.data.totals.openaiUsd, 10);
    });

    it("rejects a top-up with a made-up date", async () => {
      const res = await call("POST", `${AI}/openai/topups`, boss, { amountUsd: 10, paidOn: "2026-02-30" });
      assert.equal(res.status, 400);
    });

    it("emails the active super admins when the pool runs low", async () => {
      assert.deepEqual(await admin.superAdminEmails(), ["boss@eazotel.com"]);
    });
  });
});
