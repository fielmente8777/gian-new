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
import { TestMetaPages } from "../../meta-pages/__tests__/fakes.js";
import { InMemoryClientArchive } from "../../client-archive/__tests__/fakes.js";
import { FakeClientAccounts, FakeMailbox, InMemoryAdmins, InMemoryAuditLog, InMemoryChallenges } from "./fakes.js";

// The real App and AdminModule over HTTP, with in-memory admins, profiles and hotel accounts.

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

// fetch types json() as unknown; these tests inspect arbitrary response bodies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const CLIENTS = "/api/v1/admin/clients";

describe("admin clients", () => {
  let base: string;
  let close: () => void;
  let boss: AdminRecord;
  let staff: AdminRecord;
  const tokens = new Map<string, string>();
  const admins = new InMemoryAdmins();
  const profiles = new InMemoryProfiles();
  const users = new InMemoryUsers();
  const auditLog = new InMemoryAuditLog();
  const clientAccounts = new FakeClientAccounts();
  const subscriptions = new InMemorySubscriptions();
  const clientArchive = new InMemoryClientArchive();
  const hotelNotifications = new InMemoryHotelNotifications();
  const { store: clientServices, mailbox: digests, control: serviceControl } = TestServiceControl.create(subscriptions);
  const mailbox = new FakeMailbox();

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
    const started = await post("/google", { idToken: `google:${admin.email}:sub-${admin.email}` });
    const { challengeId } = (await json(started)).data;
    const res = await post("/otp/verify", { challengeId, code: mailbox.lastCode });
    tokens.set(admin.id, (await json(res)).data.accessToken);
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
      users,
      serviceControl,
      subscriptions,
      clientAccounts,
      clientArchive,
      hotelNotifications,
      billing: TestBillingPort.create().port,
      metaPages: TestMetaPages.create().port,
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
    profiles.rows.clear();
    users.records.clear();
    auditLog.rows.length = 0;
    profiles.add("aaa", "Amaltas Resort", [{ hid: "11111111" }, { hid: "22222222" }]);
    profiles.add("bbb", "Midori Hotel", [{ hid: "33333333" }]);
    profiles.add("ccc", "Corbett The Grand", [{ hid: "44444444" }]);
    users.add({ email: "owner@amaltas.test", ndid: "aaa", displayName: "Amaltas Owner" });
    await admins.update(staff.id, { assignedProperties: [{ ndid: "aaa", hid: "22222222" }], advancedPermissions: [] });
  });

  describe("listing", () => {
    it("a super admin sees every client, pages by cursor and can search", async () => {
      const first = (await json(await call("GET", `${CLIENTS}?limit=2`, boss))).data;
      assert.deepEqual(
        first.items.map((c: { ndid: string }) => c.ndid),
        ["aaa", "bbb"],
      );
      const second = (await json(await call("GET", `${CLIENTS}?limit=2&after=${first.nextCursor}`, boss))).data;
      assert.deepEqual(
        second.items.map((c: { ndid: string }) => c.ndid),
        ["ccc"],
      );
      assert.equal(second.nextCursor, null);

      const found = (await json(await call("GET", `${CLIENTS}?search=midori`, boss))).data;
      assert.deepEqual(
        found.items.map((c: { hotelName: string }) => c.hotelName),
        ["Midori Hotel"],
      );
    });

    it("an admin sees only clients they hold, and only their own properties of it", async () => {
      const { data } = await json(await call("GET", CLIENTS, staff));
      assert.equal(data.items.length, 1);
      assert.deepEqual(
        data.items[0].properties.map((p: { hid: string }) => p.hid),
        ["22222222"],
      );
    });

    it("an admin with no properties sees nothing", async () => {
      await admins.update(staff.id, { assignedProperties: [] });
      assert.deepEqual((await json(await call("GET", CLIENTS, staff))).data.items, []);
    });
  });

  describe("viewing", () => {
    it("shows the profile, its properties and the account holder", async () => {
      const { data } = await json(await call("GET", `${CLIENTS}/aaa`, boss));
      assert.equal(data.hotelName, "Amaltas Resort");
      assert.equal(data.properties.length, 2);
      assert.deepEqual(data.owner, { email: "owner@amaltas.test", name: "Amaltas Owner", phone: null, isActive: true });
    });

    it("a client outside an admin's properties answers 404, the same as one that does not exist", async () => {
      for (const ndid of ["bbb", "nope"]) {
        const res = await call("GET", `${CLIENTS}/${ndid}`, staff);
        assert.equal(res.status, 404);
        assert.equal((await json(res)).error.code, "CLIENT_NOT_FOUND");
      }
    });
  });

  describe("opening a client's account", () => {
    const open = (ndid: string, who: AdminRecord) => call("POST", `${CLIENTS}/${ndid}/open-account`, who);

    it("needs the clients.open_account permission", async () => {
      const res = await open("aaa", staff);
      assert.equal(res.status, 403);
      assert.equal((await json(res)).error.code, "PERMISSION_DENIED");
      assert.deepEqual(clientAccounts.issued, []);
    });

    it("gives a token for the account holder, opens on a property they may see, and logs who opened it", async () => {
      await admins.update(staff.id, { advancedPermissions: ["clients.open_account"] });
      clientAccounts.issued.length = 0;
      const res = await open("aaa", staff);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const { data } = await json(res);
      assert.equal(data.token, "client-token-for:owner@amaltas.test");
      assert.equal(data.accountEmail, "owner@amaltas.test");
      assert.equal(data.hid, "22222222", "their assigned property, not the hotel's first one");

      const [entry] = auditLog.rows;
      assert.equal(entry?.action, "client.account_opened");
      assert.equal(entry?.actorEmail, "staff@eazotel.com");
      assert.equal(entry?.targetId, "aaa");
      assert.equal(entry?.targetEmail, "owner@amaltas.test");
    });

    it("never for a client outside their properties, even with the permission", async () => {
      await admins.update(staff.id, { advancedPermissions: ["clients.open_account"] });
      clientAccounts.issued.length = 0;
      const res = await open("bbb", staff);
      assert.equal(res.status, 404);
      assert.equal((await json(res)).error.code, "CLIENT_NOT_FOUND");
      assert.deepEqual(clientAccounts.issued, []);
    });

    it("refuses a client without an account or with a turned-off one", async () => {
      const none = await open("bbb", boss);
      assert.equal(none.status, 404);
      assert.equal((await json(none)).error.code, "CLIENT_ACCOUNT_NOT_FOUND");

      users.add({ email: "off@corbett.test", ndid: "ccc", isActive: false });
      const off = await open("ccc", boss);
      assert.equal(off.status, 409);
      assert.equal((await json(off)).error.code, "CLIENT_ACCOUNT_INACTIVE");
      assert.equal(auditLog.rows.length, 0);
    });
  });

  describe("services", () => {
    const SERVICES = (ndid: string) => `${CLIENTS}/${ndid}/services`;
    beforeEach(() => {
      clientServices.switches.clear();
      clientServices.held.clear();
      clientServices.alerts.length = 0;
      clientServices.chatbots.clear();
      digests.sent.length = 0;
      subscriptions.rows.clear();
    });

    it("everything is on until someone switches it off", async () => {
      const { data } = await json(await call("GET", SERVICES("aaa"), staff));
      assert.equal(data.switches.chatbot.enabled, true);
      assert.equal(data.chatbot, true);
      assert.equal(data.leads, true);
      assert.equal(data.heldLeads, 0);
    });

    it("switching needs subscriptions.manage; viewing does not", async () => {
      const res = await call("PUT", `${SERVICES("aaa")}/chatbot`, staff, { enabled: false });
      assert.equal(res.status, 403);
      assert.equal((await json(res)).error.code, "PERMISSION_DENIED");
      assert.equal((await clientServices.get("aaa")).chatbot.enabled, true);
    });

    it("chatbot off hides it on the website at once and is logged once; on gives it back", async () => {
      clientServices.chatbots.set("aaa", { active: true, paused: false });
      const { data } = await json(await call("PUT", `${SERVICES("aaa")}/chatbot`, boss, { enabled: false }));
      assert.equal(data.chatbot, false);
      assert.equal(data.switches.chatbot.changedBy, "boss@eazotel.com");
      assert.equal(clientServices.chatbots.get("aaa")?.paused, true);

      await call("PUT", `${SERVICES("aaa")}/chatbot`, boss, { enabled: false });
      const logged = auditLog.rows.filter((r) => r.action === "client.service_changed");
      assert.equal(logged.length, 1, "switching off what is already off is not logged again");
      assert.deepEqual(logged[0]?.changes, { chatbot: { from: "on", to: "off" } });

      await call("PUT", `${SERVICES("aaa")}/chatbot`, boss, { enabled: true });
      assert.equal(clientServices.chatbots.get("aaa")?.paused, false);
    });

    it("leads back on releases held leads and sends ONE catch-up email listing them", async () => {
      await call("PUT", `${SERVICES("aaa")}/leads`, boss, { enabled: false });
      clientServices.held.set("aaa", 3);
      for (const name of ["Asha", "Ravi", "Meera"]) clientServices.addAlert("aaa", name);
      assert.equal((await json(await call("GET", SERVICES("aaa"), boss))).data.heldLeads, 3);
      assert.equal(digests.sent.length, 0, "nothing is sent while leads are off");

      const { data } = await json(await call("PUT", `${SERVICES("aaa")}/leads`, boss, { enabled: true }));
      assert.equal(data.leads, true);
      assert.deepEqual(data.released, { leads: 3, contacts: 0 });
      assert.equal(data.emailed, 3);
      assert.equal(data.heldLeads, 0);
      assert.equal(digests.sent.length, 1);
      assert.equal(digests.sent[0]?.to, "aaa@hotel.test");
      assert.match(digests.sent[0]?.text ?? "", /Asha[\s\S]*Ravi[\s\S]*Meera/);
      assert.equal(auditLog.rows.at(-1)?.details?.emailedLeads, 3);
    });

    it("a paused subscription keeps everything off whatever the switches say", async () => {
      subscriptions.add("aaa", "Amaltas Resort", 20);
      await subscriptions.pause("aaa", "boss@eazotel.com", null, new Date());
      clientServices.addAlert("aaa", "Asha");
      const { data } = await json(await call("PUT", `${SERVICES("aaa")}/leads`, boss, { enabled: true }));
      assert.equal(data.subscriptionServing, false);
      assert.equal(data.leads, false);
      assert.equal(digests.sent.length, 0);
      assert.equal(data.heldLeads, 1);
    });

    it("an admin with subscriptions.manage still can't touch a client outside their properties", async () => {
      await admins.update(staff.id, { advancedPermissions: ["subscriptions.manage"] });
      assert.equal((await call("PUT", `${SERVICES("bbb")}/leads`, staff, { enabled: false })).status, 404);
      assert.equal((await call("PUT", `${SERVICES("aaa")}/leads`, staff, { enabled: false })).status, 200);
      assert.equal((await clientServices.get("bbb")).leads.enabled, true);
    });

    it("rejects an unknown service or a body without enabled", async () => {
      assert.equal((await call("PUT", `${SERVICES("aaa")}/booking`, boss, { enabled: false })).status, 400);
      assert.equal((await call("PUT", `${SERVICES("aaa")}/chatbot`, boss, {})).status, 400);
    });
  });

  describe("lead alerts", () => {
    const ALERTS = (ndid: string) => `${CLIENTS}/${ndid}/notifications`;
    const all = (over: Record<string, unknown> = {}) =>
      Object.fromEntries(
        ["webform", "eazbot", "whatsapp", "facebook", "google"].map((s) => [
          s,
          { email: true, emails: [], whatsapp: true, phones: [], ...((over[s] as object) ?? {}) },
        ]),
      );
    beforeEach(() => {
      hotelNotifications.saved.clear();
      clientServices.switches.clear();
      subscriptions.rows.clear();
    });

    it("shows every visible property, unsaved ones with gian's defaults (everything on)", async () => {
      const { data } = await json(await call("GET", ALERTS("aaa"), boss));
      assert.deepEqual(
        data.properties.map((p: { hid: string; saved: boolean }) => [p.hid, p.saved]),
        [
          ["11111111", false],
          ["22222222", false],
        ],
      );
      assert.deepEqual(data.properties[0].sources.webform, { email: true, emails: [], whatsapp: true, phones: [] });
      assert.equal(data.leadsDelivered, true);

      const mine = (await json(await call("GET", ALERTS("aaa"), staff))).data;
      assert.deepEqual(
        mine.properties.map((p: { hid: string }) => p.hid),
        ["22222222"],
        "an admin sees only their property",
      );
    });

    it("saves one property, cleans the addresses and logs each change", async () => {
      const res = await call("PUT", `${ALERTS("aaa")}/11111111`, boss, {
        sources: all({
          webform: { email: false, emails: [" Sales@Amaltas.test ", "sales@amaltas.test"] },
          google: { whatsapp: false, phones: ["+91 98765-43210", "9876543210"] },
        }),
      });
      assert.equal(res.status, 200);
      const saved = hotelNotifications.saved.get("aaa/11111111")!;
      assert.deepEqual(saved.webform, { email: false, emails: ["sales@amaltas.test"], whatsapp: true, phones: [] });
      assert.deepEqual(saved.google.phones, ["919876543210"], "digits with the country code, once");
      assert.equal(hotelNotifications.saved.has("aaa/22222222"), false, "the other property is untouched");

      const logged = auditLog.rows.filter((r) => r.action === "client.notifications_changed");
      assert.equal(logged.length, 1);
      assert.deepEqual(logged[0]?.changes, {
        "website form email": { from: "on", to: "off" },
        "website form extra emails": { from: null, to: "sales@amaltas.test" },
        "Google Ads WhatsApp": { from: "on", to: "off" },
        "Google Ads extra numbers": { from: null, to: "919876543210" },
      });
      assert.equal(logged[0]?.details?.hid, "11111111");

      await call("PUT", `${ALERTS("aaa")}/11111111`, boss, { sources: saved });
      assert.equal(
        auditLog.rows.filter((r) => r.action === "client.notifications_changed").length,
        1,
        "saving the same again is not logged",
      );
    });

    it("says no alert goes out while leads are switched off or the subscription is paused", async () => {
      await call("PUT", `${CLIENTS}/aaa/services/leads`, boss, { enabled: false });
      assert.equal((await json(await call("GET", ALERTS("aaa"), boss))).data.leadsDelivered, false);
      await call("PUT", `${CLIENTS}/aaa/services/leads`, boss, { enabled: true });

      subscriptions.add("aaa", "Amaltas Resort", 20);
      await subscriptions.pause("aaa", "boss@eazotel.com", null, new Date());
      const { data } = await json(await call("GET", ALERTS("aaa"), boss));
      assert.equal(data.subscriptionServing, false);
      assert.equal(data.leadsDelivered, false);
    });

    it("an admin can't save a property or client that isn't theirs; viewers can't save", async () => {
      assert.equal((await call("PUT", `${ALERTS("aaa")}/11111111`, staff, { sources: all() })).status, 404);
      assert.equal((await call("PUT", `${ALERTS("bbb")}/33333333`, staff, { sources: all() })).status, 404);
      assert.equal((await call("PUT", `${ALERTS("aaa")}/22222222`, staff, { sources: all() })).status, 200);
      assert.equal((await call("PUT", `${ALERTS("aaa")}/99999999`, boss, { sources: all() })).status, 404);
    });

    it("rejects a bad email, a number without enough digits, a missing source", async () => {
      const bad = async (body: unknown) => (await call("PUT", `${ALERTS("aaa")}/11111111`, boss, body)).status;
      assert.equal(await bad({ sources: all({ webform: { emails: ["not-an-email"] } }) }), 400);
      assert.equal(await bad({ sources: all({ eazbot: { phones: ["12345"] } }) }), 400);
      const { google: _google, ...missing } = all();
      assert.equal(await bad({ sources: missing }), 400);
      assert.equal(hotelNotifications.saved.size, 0);
    });
  });

  describe("deleting", () => {
    beforeEach(() => {
      clientArchive.data.clear();
      clientArchive.deleted.length = 0;
      clientArchive.data.set("aaa", { Zucks_profile: 1, Zucks_users: 2, ContactUs: 40, subscriptions: 1 });
    });

    it("is for super admins only, even an admin holding every advanced permission", async () => {
      await admins.update(staff.id, {
        advancedPermissions: ["clients.open_account", "subscriptions.manage", "credits.manage"],
      });
      for (const res of [
        await call("GET", `${CLIENTS}/aaa/deletion-preview`, staff),
        await call("DELETE", `${CLIENTS}/aaa`, staff, { confirmName: "Amaltas Resort" }),
      ]) {
        assert.equal(res.status, 403);
        assert.equal((await json(res)).error.code, "PERMISSION_DENIED");
      }
      assert.equal(clientArchive.deleted.length, 0);
    });

    it("previews exactly what would go", async () => {
      const { data } = await json(await call("GET", `${CLIENTS}/aaa/deletion-preview`, boss));
      assert.equal(data.hotelName, "Amaltas Resort");
      assert.equal(data.total, 44);
      assert.deepEqual(data.collections[0], { collection: "ContactUs", count: 40 });
    });

    it("needs the hotel's name typed exactly (any case, extra spaces ignored)", async () => {
      const wrong = await call("DELETE", `${CLIENTS}/aaa`, boss, { confirmName: "Amaltas" });
      assert.equal(wrong.status, 400);
      assert.equal((await json(wrong)).error.code, "CONFIRMATION_MISMATCH");
      assert.equal((await call("DELETE", `${CLIENTS}/aaa`, boss, {})).status, 400);
      assert.equal(clientArchive.deleted.length, 0);

      const res = await call("DELETE", `${CLIENTS}/aaa`, boss, {
        confirmName: "  amaltas   RESORT ",
        reason: "demo account",
      });
      assert.equal(res.status, 200);
      const { data } = await json(res);
      assert.equal(data.total, 44);
      assert.ok(data.deletionId);
      assert.deepEqual(clientArchive.deleted[0], {
        ndid: "aaa",
        meta: { hotelName: "Amaltas Resort", by: "boss@eazotel.com", reason: "demo account" },
      });
      const entry = auditLog.rows.find((r) => r.action === "client.deleted");
      assert.equal(entry?.targetId, "aaa");
      assert.equal(entry?.details?.records, 44);
      assert.equal(entry?.details?.reason, "demo account");
    });

    it("404 for a client that doesn't exist", async () => {
      assert.equal((await call("DELETE", `${CLIENTS}/nope`, boss, { confirmName: "x" })).status, 404);
    });
  });

  describe("editing", () => {
    it("changes only the fields sent, logs old and new values, and clears a field with empty text", async () => {
      await call("PATCH", `${CLIENTS}/aaa`, boss, { hotelPhone: "+91 99999 00000" });
      auditLog.rows.length = 0;

      const res = await call("PATCH", `${CLIENTS}/aaa`, staff, {
        hotelEmail: " Front@Amaltas.TEST ",
        hotelPhone: "",
        properties: { "22222222": { name: "Amaltas Lake Wing", city: "Udaipur" } },
      });
      assert.equal(res.status, 200);
      const { data } = await json(res);
      assert.equal(data.hotelEmail, "front@amaltas.test");
      assert.equal(data.hotelPhone, null);
      assert.equal(data.properties[0].name, "Amaltas Lake Wing");

      const stored = await profiles.findByNdid("aaa");
      assert.equal(stored?.hotelName, "Amaltas Resort", "untouched fields stay");
      assert.equal(stored?.properties[0]?.name, "Amaltas Resort 1", "the other property stays");

      const [entry] = auditLog.rows;
      assert.equal(entry?.action, "client.updated");
      assert.equal(entry?.actorEmail, "staff@eazotel.com");
      assert.equal(entry?.targetId, "aaa");
      assert.deepEqual(entry?.changes?.hotelPhone, { from: "+91 99999 00000", to: null });
      assert.deepEqual(entry?.changes?.["property 22222222 city"], { from: null, to: "Udaipur" });
    });

    it("logs nothing when nothing really changed", async () => {
      const res = await call("PATCH", `${CLIENTS}/aaa`, boss, { hotelEmail: "aaa@hotel.test" });
      assert.equal(res.status, 200);
      assert.equal(auditLog.rows.length, 0);
    });

    it("an admin can't edit a property of the client that isn't theirs, or a client that isn't", async () => {
      const property = await call("PATCH", `${CLIENTS}/aaa`, staff, { properties: { "11111111": { city: "X" } } });
      assert.equal(property.status, 404);
      assert.equal((await json(property)).error.code, "PROPERTY_NOT_FOUND");
      assert.equal((await call("PATCH", `${CLIENTS}/bbb`, staff, { hotelPhone: "1" })).status, 404);
      assert.equal(auditLog.rows.length, 0);
    });

    it("refuses the hotel name, a bad email, and an empty change", async () => {
      assert.equal((await call("PATCH", `${CLIENTS}/aaa`, boss, { hotelName: "New" })).status, 400);
      assert.equal((await call("PATCH", `${CLIENTS}/aaa`, boss, { hotelEmail: "not-an-email" })).status, 400);
      assert.equal((await call("PATCH", `${CLIENTS}/aaa`, boss, {})).status, 400);
      assert.equal((await profiles.findByNdid("aaa"))?.hotelName, "Amaltas Resort");
    });
  });
});
