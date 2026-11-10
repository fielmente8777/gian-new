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
import { InMemoryClientArchive } from "../../client-archive/__tests__/fakes.js";
import { TestServiceControl } from "../../client-services/__tests__/fakes.js";
import { InMemoryHotelNotifications } from "../../hotel-notifications/__tests__/fakes.js";
import { TestMetaPages } from "../../meta-pages/__tests__/fakes.js";
import { InMemoryProfiles } from "../../profiles/__tests__/fakes.js";
import { InMemorySubscriptions } from "../../subscriptions/__tests__/fakes.js";
import { AdminModule } from "../admin.module.js";
import { adminConfig } from "../config/admin.config.js";
import type { AdminRecord } from "../types/admin.types.js";
import { FakeClientAccounts, FakeMailbox, InMemoryAdmins, InMemoryAuditLog, InMemoryChallenges } from "./fakes.js";

// The real App and AdminModule over HTTP, with in-memory pageconnections and a fake Meta.

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const META = "/api/v1/admin/meta-pages";
const page = (id: string, name: string, link?: { ndid: string; hid: string }) => ({
  id,
  name,
  access_token: `token-${id}`,
  category: "Hotel",
  ...(link ?? {}),
});

describe("admin meta pages", () => {
  let base: string;
  let close: () => void;
  let boss: AdminRecord;
  let staff: AdminRecord;
  let agencyId: string;
  let hotelId: string;
  const tokens = new Map<string, string>();
  const admins = new InMemoryAdmins();
  const profiles = new InMemoryProfiles();
  const auditLog = new InMemoryAuditLog();
  const meta = TestMetaPages.create();
  const subscriptions = new InMemorySubscriptions();
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
      users: new InMemoryUsers(),
      serviceControl: TestServiceControl.create(subscriptions).control,
      subscriptions,
      clientAccounts: new FakeClientAccounts(),
      clientArchive: new InMemoryClientArchive(),
      hotelNotifications: new InMemoryHotelNotifications(),
      billing: TestBillingPort.create().port,
      metaPages: meta.port,
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
    auditLog.rows.length = 0;
    meta.store.docs.length = 0;
    meta.graph.pagesByToken.clear();
    meta.graph.subscribed.length = 0;
    profiles.add("agency", "Eazotel Technologies", [{ hid: "10000000" }]);
    profiles.add("corbett", "Corbett The Grand", [{ hid: "26723586" }]);
    profiles.add("midori", "Midori", [{ hid: "96210201" }, { hid: "96210202" }]);
    // the agency's sign-in has both pages, Corbett linked; the hotel's own sign-in has Corbett unlinked
    agencyId = meta.store.add({
      ndid: "agency",
      hid: "10000000",
      pages: [
        page("1743945545929938", "Corbett The Grand", { ndid: "corbett", hid: "26723586" }),
        page("1365422919986405", "Midori Chennai"),
      ],
    });
    hotelId = meta.store.add({
      ndid: "midori",
      hid: "96210201",
      pages: [page("1743945545929938", "Corbett The Grand")],
    });
    await admins.update(staff.id, {
      advancedPermissions: ["meta_pages.manage"],
      assignedProperties: [{ ndid: "midori", hid: "96210201" }],
    });
  });

  it("lists every page once, with where its leads go and the hotel names", async () => {
    const res = await call("GET", META, boss);
    assert.equal(res.status, 200);
    const { pages, connections, counts } = (await json(res)).data;
    assert.deepEqual(counts, { pages: 2, linked: 1, unlinked: 1, conflicts: 0 });
    const corbett = pages.find((p: { pageId: string }) => p.pageId === "1743945545929938");
    assert.equal(corbett.link.hotelName, "Corbett The Grand");
    assert.equal(corbett.link.hid, "26723586");
    assert.equal(corbett.connections.length, 2);
    assert.equal(connections.length, 2);
    assert.equal(connections[0].owner.hotelName, "Eazotel Technologies");
    // tokens never leave gian-new
    assert.doesNotMatch(JSON.stringify(pages) + JSON.stringify(connections), /token-|user-token/);
  });

  it("links a page in every copy and logs it", async () => {
    const res = await call("PUT", `${META}/1743945545929938/link`, boss, { ndid: "midori", hid: "96210202" });
    assert.equal(res.status, 200);
    const body = (await json(res)).data;
    assert.equal(body.link.propertyName, "Midori 2");
    for (const doc of meta.store.docs) {
      const copy = doc.pages.find((p) => p.id === "1743945545929938");
      assert.deepEqual({ ndid: copy?.ndid, hid: copy?.hid }, { ndid: "midori", hid: "96210202" });
    }
    const entry = auditLog.rows.find((r) => r.action === "meta_page.linked");
    assert.deepEqual(entry?.changes?.link, {
      from: { ndid: "corbett", hid: "26723586" },
      to: { ndid: "midori", hid: "96210202" },
    });
  });

  it("refuses unknown pages, clients and properties", async () => {
    assert.equal((await call("PUT", `${META}/99999999/link`, boss, { ndid: "midori", hid: "96210201" })).status, 404);
    const noClient = await call("PUT", `${META}/1365422919986405/link`, boss, { ndid: "nobody", hid: "1" });
    assert.equal(noClient.status, 404);
    assert.equal((await json(noClient)).error.code, "CLIENT_NOT_FOUND");
    const noProperty = await call("PUT", `${META}/1365422919986405/link`, boss, { ndid: "midori", hid: "123" });
    assert.equal(noProperty.status, 404);
  });

  it("keeps an admin to their own properties", async () => {
    // an unlinked page can be linked to their property, not to someone else's
    assert.equal(
      (await call("PUT", `${META}/1365422919986405/link`, staff, { ndid: "midori", hid: "96210201" })).status,
      200,
    );
    assert.equal(
      (await call("PUT", `${META}/1365422919986405/link`, staff, { ndid: "corbett", hid: "26723586" })).status,
      404,
    );
    // Corbett's page is another client's: they can't move or unlink it
    const taken = await call("PUT", `${META}/1743945545929938/link`, staff, { ndid: "midori", hid: "96210201" });
    assert.equal(taken.status, 403);
    assert.equal((await call("DELETE", `${META}/1743945545929938/link`, staff)).status, 403);
    // without the permission there is no screen at all
    await admins.update(staff.id, { advancedPermissions: [] });
    assert.equal((await call("GET", META, staff)).status, 403);
  });

  it("unlinks a page everywhere", async () => {
    const res = await call("DELETE", `${META}/1743945545929938/link`, boss);
    assert.equal(res.status, 200);
    assert.equal((await json(res)).data.link, null);
    assert.ok(meta.store.docs.every((d) => d.pages.every((p) => !p.ndid)));
    assert.ok(auditLog.rows.some((r) => r.action === "meta_page.unlinked"));
  });

  it("syncs from Meta: adds new pages with their existing link, keeps links and missing pages", async () => {
    meta.store.docs[1]!.longLivedToken = "hotel-token";
    meta.graph.pagesByToken.set("hotel-token", [
      {
        id: "1743945545929938",
        name: "Corbett The Grand (new name)",
        accessToken: "fresh",
        category: "Hotel",
        picture: null,
        instagram: null,
      },
      {
        id: "1365422919986405",
        name: "Midori Chennai",
        accessToken: "fresh-2",
        category: "Hotel",
        picture: null,
        instagram: null,
      },
    ]);
    // link Midori's page through the agency copy first, so the new copy must inherit it
    await call("PUT", `${META}/1365422919986405/link`, boss, { ndid: "midori", hid: "96210201" });
    const res = await call("POST", `${META}/connections/${hotelId}/sync`, boss);
    assert.equal(res.status, 200);
    const result = (await json(res)).data;
    assert.deepEqual(result.added, ["1365422919986405"]);
    assert.equal(result.updated, 1);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(meta.graph.subscribed.sort(), ["1365422919986405", "1743945545929938"]);
    const doc = meta.store.docs[1]!;
    assert.equal(doc.pages[0]?.name, "Corbett The Grand (new name)");
    assert.equal(doc.pages[0]?.access_token, "fresh");
    assert.deepEqual({ ndid: doc.pages[1]?.ndid, hid: doc.pages[1]?.hid }, { ndid: "midori", hid: "96210201" });
    assert.ok(auditLog.rows.some((r) => r.action === "meta_pages.synced"));
  });

  it("says when a connection can't be synced", async () => {
    meta.store.docs[0]!.longLivedToken = null;
    const res = await call("POST", `${META}/connections/${agencyId}/sync`, boss);
    assert.equal(res.status, 409);
    assert.equal((await call("POST", `${META}/connections/${"f".repeat(24)}/sync`, boss)).status, 404);
  });
});
