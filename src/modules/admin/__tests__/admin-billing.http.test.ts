import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

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
import { InMemorySubscriptions } from "../../subscriptions/__tests__/fakes.js";
import { TestReminders } from "../../renewal-reminders/__tests__/fakes.js";
import { AdminModule } from "../admin.module.js";
import { adminConfig } from "../config/admin.config.js";
import type { AdminRecord } from "../types/admin.types.js";
import { FakeClientAccounts, FakeMailbox, InMemoryAdmins, InMemoryAuditLog, InMemoryChallenges } from "./fakes.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const BILLING = "/api/v1/admin/billing";

describe("admin billing", () => {
  let base: string;
  let close: () => void;
  let boss: AdminRecord;
  let staff: AdminRecord;
  let finance: AdminRecord;
  const tokens = new Map<string, string>();
  const admins = new InMemoryAdmins();
  const auditLog = new InMemoryAuditLog();
  const mailbox = new FakeMailbox();
  const billing = TestBillingPort.create();

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
    const subscriptions = new InMemorySubscriptions();
    const admin = new AdminModule({
      config: config.admin,
      authConfig: config.auth,
      logger,
      events: new EventBus(logger),
      mailer: mailbox,
      profiles: new InMemoryProfiles(),
      users: new InMemoryUsers(),
      clientAccounts: new FakeClientAccounts(),
      serviceControl: TestServiceControl.create(subscriptions).control,
      subscriptions,
      clientArchive: new InMemoryClientArchive(),
      clientTrash: new InMemoryClientTrash(),
      hotelNotifications: new InMemoryHotelNotifications(),
      billing: billing.port,
      metaPages: TestMetaPages.create().port,
      reminders: TestReminders.create(subscriptions, mailbox).port,
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
    finance = admins.add({ email: "finance@eazotel.com", advancedPermissions: ["billing.view"] });
    for (const a of [boss, staff, finance]) await signIn(a);
  });
  after(() => close());

  it("keeps billing away from admins without billing permissions", async () => {
    assert.equal((await call("GET", `${BILLING}/overview`, staff)).status, 403);
    assert.equal((await call("GET", `${BILLING}/overview`, finance)).status, 200);
    const pro = billing.catalogueStore.plansList.find((p) => p.code === "PRO")!;
    const denied = await call("PATCH", `${BILLING}/plans/${pro.id}`, finance, { price: 1 });
    assert.equal((await json(denied)).error.code, "PERMISSION_DENIED", "billing.view can't change prices");
  });

  it("creates an invoice for an older paid payment, downloads it and emails it to the hotel", async () => {
    const now = new Date();
    await billing.payments.create({
      ndid: "hotel-x",
      orderId: "order_old",
      paymentId: "pay_old",
      planId: billing.catalogueStore.plansList.find((p) => p.code === "PRO")!.id,
      amount: 117_882,
      currency: "INR",
      status: "SUCCESS",
      method: null,
      paidAt: now,
      createdAt: now,
      source: null,
      kind: null,
      terms: null,
      quote: null,
      offerCode: null,
      periodStart: null,
      periodEnd: null,
      autoRenewRequested: false,
      createdBy: null,
    });
    // finance looks after this hotel only; scoping hides every other one
    await admins.update(finance.id, { assignedProperties: [{ ndid: "hotel-x", hid: "h1" }] });
    const listed = (await json(await call("GET", `${BILLING}/payments`, finance))).data;
    assert.equal(listed.items.find((p: { orderId: string }) => p.orderId === "order_old").invoice, null);

    assert.equal(
      (await call("POST", `${BILLING}/payments/order_old/invoice`, finance)).status,
      403,
      "creating needs billing.manage",
    );
    const created = await call("POST", `${BILLING}/payments/order_old/invoice`, boss);
    assert.equal(created.status, 201);
    const invoice = (await json(created)).data;
    assert.match(invoice.number, /^EZ\/\d{2}-\d{2}\/00001$/);
    assert.deepEqual(invoice.suggestedRecipients, ["desk@hotel.test", "owner@hotel.test"]);

    const pdf = await call("GET", `${BILLING}/invoices/${invoice.id}/pdf`, finance);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");

    const sent = (
      await json(
        await call("POST", `${BILLING}/invoices/${invoice.id}/email`, finance, { to: ["accounts@hotel.test"] }),
      )
    ).data;
    assert.deepEqual(sent.emailedTo, ["accounts@hotel.test"]);
    assert.equal(billing.mailbox.sent.at(-1)?.to, "accounts@hotel.test");
    assert.equal(billing.mailbox.sent.at(-1)?.attachments?.[0]?.contentType, "application/pdf");
    assert.ok(
      auditLog.rows.some((r) => r.action === "billing.invoice_emailed" && r.targetEmail === "accounts@hotel.test"),
    );
    const relisted = (await json(await call("GET", `${BILLING}/payments`, finance))).data;
    assert.equal(
      relisted.items.find((p: { orderId: string }) => p.orderId === "order_old").invoice.number,
      invoice.number,
    );
  });

  it("changes a plan's price and apps, logging old and new values", async () => {
    const pro = billing.catalogueStore.plansList.find((p) => p.code === "PRO")!;
    const res = await call("PATCH", `${BILLING}/plans/${pro.id}`, boss, {
      price: 1299,
      includedApps: ["whatsapp", "exotel"],
    });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).data.price, 1299);
    const entry = auditLog.rows.find((r) => r.action === "billing.plan_updated")!;
    assert.deepEqual(entry.changes?.price, { from: 999, to: 1299 });
    assert.equal(entry.targetId, "PRO");

    const worded = await call("PATCH", `${BILLING}/plans/${pro.id}`, boss, {
      customPriceLabel: "Get a quote",
      customCtaLabel: "Chat with us",
    });
    assert.equal((await json(worded)).data.customPriceLabel, "Get a quote");
    assert.equal(
      (await call("PATCH", `${BILLING}/plans/${pro.id}`, boss, { customPriceLabel: "x".repeat(31) })).status,
      400,
    );

    const unknown = await call("PATCH", `${BILLING}/plans/${pro.id}`, boss, { includedApps: ["nope"] });
    assert.equal((await json(unknown)).error.code, "UNKNOWN_APP_CODES");
  });

  it("creates a private plan, a new app, settings and an offer; duplicates are refused", async () => {
    const plan = await call("POST", `${BILLING}/plans`, boss, {
      code: "enterprise_amaltas",
      name: "Enterprise – Amaltas",
      price: 4999,
      includedApps: ["whatsapp"],
      limits: { teamMembers: 25, properties: -1, aiCreditsMonthly: 5000, maxLeadsPerMonth: -1 },
      isPublic: false,
      isCustom: true,
      visibleTo: ["ndid-amaltas"],
    });
    assert.equal(plan.status, 201);
    assert.equal((await json(plan)).data.code, "ENTERPRISE_AMALTAS");
    const again = await call("POST", `${BILLING}/plans`, boss, {
      code: "ENTERPRISE_AMALTAS",
      name: "x",
      price: 1,
      limits: { teamMembers: 1, properties: 1, aiCreditsMonthly: 0, maxLeadsPerMonth: -1 },
    });
    assert.equal((await json(again)).error.code, "PLAN_CODE_TAKEN");

    assert.equal(
      (await call("POST", `${BILLING}/apps`, boss, { code: "channel_manager", name: "Channel Manager", price: 1500 }))
        .status,
      201,
    );

    const badCycles = await call("PUT", `${BILLING}/settings`, boss, {
      gstPercent: 18,
      seatPrice: 500,
      trialDays: 14,
      cycles: [
        { months: 1, label: "Monthly", discountPercent: 0 },
        { months: 1, label: "Again", discountPercent: 5 },
      ],
    });
    assert.equal(badCycles.status, 400);
    const settings = await call("PUT", `${BILLING}/settings`, boss, {
      gstPercent: 18,
      seatPrice: 600,
      trialDays: 14,
      cycles: [
        { months: 1, label: "Monthly", discountPercent: 0 },
        { months: 12, label: "Yearly", discountPercent: 25 },
      ],
    });
    assert.equal((await json(settings)).data.seatPrice, 600);

    const offer = await call("POST", `${BILLING}/offers`, boss, {
      code: "diwali25",
      name: "Diwali",
      type: "percent",
      value: 25,
    });
    assert.equal((await json(offer)).data.code, "DIWALI25");
    const tooMuch = await call("POST", `${BILLING}/offers`, boss, {
      code: "HALF",
      name: "x",
      type: "percent",
      value: 150,
    });
    assert.equal(tooMuch.status, 400);

    const catalogue = (await json(await call("GET", `${BILLING}/catalogue`, finance))).data;
    assert.ok(catalogue.plans.some((p: { code: string }) => p.code === "ENTERPRISE_AMALTAS"));
    assert.equal(catalogue.offers.length, 1);
    const actions = auditLog.rows.map((r) => r.action);
    for (const action of [
      "billing.plan_created",
      "billing.app_created",
      "billing.settings_updated",
      "billing.offer_created",
    ])
      assert.ok(actions.includes(action as never), action);
  });
});
