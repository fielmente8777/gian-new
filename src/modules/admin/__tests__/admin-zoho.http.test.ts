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
import { AdminZohoService } from "../services/admin-zoho.service.js";
import type { AdminRecord } from "../types/admin.types.js";
import { FakeClientAccounts, FakeMailbox, InMemoryAdmins, InMemoryAuditLog, InMemoryChallenges } from "./fakes.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const ZOHO = "/api/v1/admin/zoho";

describe("admin Zoho Books", () => {
  let base: string;
  let close: () => void;
  let boss: AdminRecord;
  let staff: AdminRecord;
  const tokens = new Map<string, string>();
  const admins = new InMemoryAdmins();
  const auditLog = new InMemoryAuditLog();
  const mailbox = new FakeMailbox();
  const profiles = new InMemoryProfiles();
  const subscriptions = new InMemorySubscriptions();
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
      profiles,
      users: new InMemoryUsers(),
      serviceControl: TestServiceControl.create(subscriptions).control,
      subscriptions,
      clientAccounts: new FakeClientAccounts(),
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
    await signIn(boss);
    await signIn(staff);
  });
  after(() => close());
  beforeEach(async () => {
    auditLog.rows.length = 0;
    profiles.rows.clear();
    profiles.add("gc", "Greencastle");
    profiles.add("mid", "Midori Hotel");
    billing.zohoStore.conn = null;
    billing.zohoStore.setup = { provider: "razorpay", changedBy: null, changedAt: null };
    billing.zohoStore.linkRows.clear();
  });

  const connect = async () => {
    const { data } = await json(await call("POST", `${ZOHO}/connect`, boss));
    const state = new URL(data.url).searchParams.get("state")!;
    return billing.port.zoho.connection.finishConnect("good-code", state, undefined);
  };

  it("connecting and switching need billing.manage, and the switch is logged", async () => {
    assert.equal((await call("POST", `${ZOHO}/connect`, staff)).status, 403);
    assert.equal((await call("PUT", `${ZOHO}/provider`, boss, { provider: "zoho" })).status, 409, "not connected yet");

    await connect();
    const res = await call("PUT", `${ZOHO}/provider`, boss, { provider: "zoho" });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).data.payment.provider, "zoho");
    const [entry] = auditLog.rows.filter((r) => r.action === "billing.payment_provider_changed");
    assert.deepEqual(entry?.details, { from: "razorpay", to: "zoho" });

    const back = await json(await call("PUT", `${ZOHO}/provider`, boss, { provider: "razorpay" }));
    assert.equal(back.data.payment.provider, "razorpay", "switching back is one click");
  });

  it("suggests which client each Zoho customer is, and links it", async () => {
    await connect();
    const contact = await billing.zoho.createContact({ accessToken: "", apiDomain: "" }, "org-1", {
      name: "The Green Castle Resort Pvt Ltd",
      email: null,
      phone: null,
    });
    await billing.zoho.createContact({ accessToken: "", apiDomain: "" }, "org-1", {
      name: "Someone else entirely",
      email: null,
      phone: null,
    });

    const { data } = await json(await call("GET", `${ZOHO}/customers`, boss));
    const row = data.items.find((r: { contact: { contactId: string } }) => r.contact.contactId === contact.contactId);
    assert.equal(row.suggestion?.ndid, "gc", "“The Green Castle Resort Pvt Ltd” is Greencastle");

    const linked = await call("PUT", `${ZOHO}/links/gc`, boss, { contactId: contact.contactId });
    assert.equal(linked.status, 200);
    assert.equal((await billing.zohoStore.linkByNdid("gc"))?.contactId, contact.contactId);
    assert.ok(auditLog.rows.some((r) => r.action === "zoho.customer_linked" && r.targetId === "gc"));
  });

  it("matches names without the filler words, and by email", () => {
    const clients = [profiles.add("a", "Hotel Amaltas"), profiles.add("b", "Corbett The Grand")];
    const contact = (name: string, email: string | null = null) => ({
      contactId: "x",
      name,
      companyName: "",
      email,
      phone: null,
      status: "active",
    });
    assert.equal(AdminZohoService.bestMatch(contact("Amaltas Resorts Pvt. Ltd."), clients)?.ndid, "a");
    assert.equal(AdminZohoService.bestMatch(contact("Corbett Grand"), clients)?.ndid, "b");
    assert.equal(AdminZohoService.bestMatch(contact("Nothing Alike"), clients), null);
    assert.equal(AdminZohoService.bestMatch(contact("Different name", "b@hotel.test"), clients)?.why, "same email");
  });
});
