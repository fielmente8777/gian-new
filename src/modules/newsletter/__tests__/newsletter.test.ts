import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NewsletterService } from "../services/newsletter.service.js";
import { SignupService } from "../services/signup.service.js";
import { UnsubscribeLinks } from "../services/unsubscribe-links.js";
import { FakeHotels, InMemorySettings, InMemorySubscribers, RecordingMailer, silentLogger } from "./fakes.js";

const NOW = new Date("2026-11-16T10:00:00Z");
const SECRET = "a-test-secret-that-is-long-enough-123456";
const flush = () => new Promise((resolve) => setImmediate(resolve));

const setup = (opts: { serving?: boolean; links?: boolean } = {}) => {
  const subscribers = new InMemorySubscribers();
  const settings = new InMemorySettings();
  const mailer = new RecordingMailer();
  const hotels = new FakeHotels([
    { ndid: "n1", hotelName: "Hill View", alertEmails: ["owner@hillview.test"], domain: "hillview.com" },
  ]);
  const links = opts.links === false ? null : new UnsubscribeLinks(SECRET, "https://gn.eazotel.com/");
  const service = new NewsletterService(subscribers, settings, () => NOW);
  const signup = new SignupService(
    subscribers,
    settings,
    hotels,
    mailer,
    links,
    silentLogger,
    async () => opts.serving ?? true,
    () => NOW,
  );
  return { subscribers, settings, mailer, links, service, signup };
};

describe("UnsubscribeLinks", () => {
  const links = new UnsubscribeLinks(SECRET, "https://gn.eazotel.com/");

  it("round-trips the client and a lower-cased address", () => {
    assert.deepEqual(links.verify(links.token("n1", "Guest@Mail.com")), { ndid: "n1", email: "guest@mail.com" });
  });

  it("makes the same token as gian's campaign sender (gian/tests/newsletter)", () => {
    assert.equal(links.token("n1", "Guest@Mail.com"), "WyJuMSIsImd1ZXN0QG1haWwuY29tIl0.icBAiFfw98Ai31vw0NETct");
  });

  it("builds the link on the public URL without a double slash", () => {
    assert.match(links.url("n1", "a@b.co"), /^https:\/\/gn\.eazotel\.com\/newsletter\/unsubscribe\?t=[\w-]+\.[\w-]+$/);
  });

  it("rejects an edited payload, a foreign secret and junk", () => {
    const token = links.token("n1", "a@b.co");
    const forged = `${Buffer.from(JSON.stringify(["n2", "a@b.co"])).toString("base64url")}.${token.split(".")[1]}`;
    assert.equal(links.verify(forged), null);
    assert.equal(new UnsubscribeLinks(`${SECRET}x`, "x").verify(token), null);
    assert.equal(links.verify("nope"), null);
    assert.equal(links.verify(undefined), null);
  });
});

describe("NewsletterService", () => {
  it("adds by hand, lower-cases, and refuses a duplicate", async () => {
    const { service } = setup();
    const added = await service.add("n1", { email: " Guest@Mail.COM ", name: " Asha ", tags: ["vip", "vip", " "] });
    assert.equal(added.email, "guest@mail.com");
    assert.equal(added.name, "Asha");
    assert.deepEqual(added.tags, ["vip"]);
    assert.equal(added.source, "manual");
    await assert.rejects(service.add("n1", { email: "guest@mail.com" }), { code: "SUBSCRIBER_EXISTS" });
    await assert.rejects(service.add("n1", { email: "not-an-email" }), { code: "INVALID_EMAIL" });
  });

  it("never re-adds someone who unsubscribed themselves, by hand, bulk or import", async () => {
    const { service, subscribers } = setup();
    const row = await subscribers.insert("n1", { email: "out@mail.com", source: "website", status: "unsubscribed" }, NOW);
    await assert.rejects(service.add("n1", { email: "out@mail.com" }), { code: "SUBSCRIBER_OPTED_OUT" });
    await assert.rejects(service.edit("n1", row.id, { status: "subscribed" }), { code: "SUBSCRIBER_OPTED_OUT" });
    assert.deepEqual(await service.bulk("n1", [row.id], "resubscribe"), { changed: 0, skipped: 1 });
    const result = await service.import("n1", [{ email: "out@mail.com" }]);
    assert.equal(result.skippedUnsubscribed, 1);
    assert.equal((await subscribers.byEmail("n1", "out@mail.com"))?.status, "unsubscribed");
  });

  it("lets the hotel undo its own unsubscribe", async () => {
    const { service } = setup();
    const row = await service.add("n1", { email: "a@mail.com" });
    await service.bulk("n1", [row.id], "unsubscribe");
    const back = await service.edit("n1", row.id, { status: "subscribed" });
    assert.equal(back.status, "subscribed");
  });

  it("imports: counts invalid rows and repeats, fills names, adds tags", async () => {
    const { service } = setup();
    await service.add("n1", { email: "known@mail.com" });
    const result = await service.import(
      "n1",
      [
        { email: "new@mail.com", name: "New" },
        { email: "NEW@mail.com" },
        { email: "known@mail.com", name: "Known" },
        { email: "broken" },
      ],
      ["diwali-2026"],
    );
    assert.deepEqual(result, { added: 1, updated: 1, skippedUnsubscribed: 0, invalid: 1, duplicatesInFile: 1 });
    assert.deepEqual(await service.tags("n1"), ["diwali-2026"]);
  });

  it("sends only to subscribed addresses, optionally by tag", async () => {
    const { service } = setup();
    const a = await service.add("n1", { email: "a@mail.com", tags: ["vip"] });
    await service.add("n1", { email: "b@mail.com" });
    const c = await service.add("n1", { email: "c@mail.com", tags: ["vip"] });
    await service.bulk("n1", [c.id], "unsubscribe");
    assert.deepEqual((await service.audience("n1")).sort(), ["a@mail.com", "b@mail.com"]);
    assert.deepEqual(await service.audience("n1", "vip"), [a.email]);
  });

  it("exports CSV safe for Excel (BOM, quoting, no formulas)", async () => {
    const { service } = setup();
    await service.add("n1", { email: "a@mail.com", name: '=HYPERLINK("x"), "Bob"' });
    const csv = await service.exportCsv("n1", {});
    assert.ok(csv.startsWith("﻿Email,Name,Status"));
    assert.match(csv, /a@mail\.com,"'=HYPERLINK\(""x""\), ""Bob""",subscribed,manual,,2026-11-16,/);
  });

  it("gives default settings until the hotel saves its own", async () => {
    const { service } = setup();
    assert.equal((await service.settings("n1")).welcome.enabled, false);
    const saved = await service.saveSettings("n1", {
      welcome: { enabled: true, subject: "Hi", message: "Hello {{name}}" },
      notifyOnSignup: true,
    });
    assert.equal(saved.updatedAt, NOW);
    assert.equal((await service.settings("n1")).welcome.subject, "Hi");
  });
});

describe("SignupService", () => {
  it("signs up from the website domain, then answers already_subscribed", async () => {
    const { signup, subscribers } = setup();
    assert.equal(await signup.subscribe({ site: "https://www.HillView.com/", email: "Guest@Mail.com" }), "subscribed");
    assert.equal(await signup.subscribe({ site: "hillview.com", email: "guest@mail.com" }), "already_subscribed");
    assert.equal(subscribers.rows.length, 1);
    assert.equal(subscribers.rows[0]!.source, "website");
  });

  it("rejects bad input", async () => {
    const { signup } = setup();
    await assert.rejects(signup.subscribe({ site: "hillview.com", email: "nope" }), { code: "INVALID_EMAIL" });
    await assert.rejects(signup.subscribe({ site: "other.com", email: "a@b.co" }), { code: "UNKNOWN_WEBSITE" });
  });

  it("sends the welcome email with filled-in names and an unsubscribe link, and alerts the hotel", async () => {
    const { signup, service, mailer } = setup();
    await service.saveSettings("n1", {
      welcome: { enabled: true, subject: "Welcome to {{hotel}}", message: "Hi {{name}},\n\nSee you at {{ hotel }}." },
      notifyOnSignup: true,
    });
    await signup.subscribe({ site: "hillview.com", email: "asha@mail.com", name: "Asha" });
    await flush();
    const [welcome, alert] = mailer.sent;
    assert.equal(welcome?.to, "asha@mail.com");
    assert.equal(welcome?.subject, "Welcome to Hill View");
    assert.match(welcome!.text, /^Hi Asha,\n\nSee you at Hill View\./);
    assert.match(welcome!.html!, /newsletter\/unsubscribe\?t=/);
    assert.equal(alert?.to, "owner@hillview.test");
  });

  it("sends nothing while the hotel's subscription has ended, but keeps the signup", async () => {
    const { signup, service, mailer, subscribers } = setup({ serving: false });
    await service.saveSettings("n1", { welcome: { enabled: true, subject: "s", message: "m" }, notifyOnSignup: true });
    await signup.subscribe({ site: "hillview.com", email: "a@mail.com" });
    await flush();
    assert.equal(mailer.sent.length, 0);
    assert.equal(subscribers.rows.length, 1);
  });

  it("unsubscribes from a link, records why, and lets the person sign up again themselves", async () => {
    const { signup, links, subscribers } = setup();
    await signup.subscribe({ site: "hillview.com", email: "a@mail.com" });
    const token = links!.token("n1", "a@mail.com");
    assert.equal((await signup.preview(token))?.alreadyOut, false);
    assert.deepEqual(await signup.unsubscribe(token, "Too many emails"), { email: "a@mail.com", hotelName: "Hill View" });
    const row = await subscribers.byEmail("n1", "a@mail.com");
    assert.equal(row?.status, "unsubscribed");
    assert.equal(row?.unsubscribedBy, "subscriber");
    assert.equal(row?.unsubscribeReason, "Too many emails");
    assert.equal((await signup.preview(token))?.alreadyOut, true);
    assert.equal(await signup.subscribe({ site: "hillview.com", email: "a@mail.com" }), "resubscribed");
  });

  it("adds a campaign recipient who was never on the list as unsubscribed", async () => {
    const { signup, links, subscribers } = setup();
    await signup.unsubscribe(links!.token("n1", "lead@mail.com"));
    const row = await subscribers.byEmail("n1", "lead@mail.com");
    assert.equal(row?.status, "unsubscribed");
    assert.equal(row?.source, "campaign");
  });

  it("refuses a forged link, and every link when the secret isn't set", async () => {
    const { signup } = setup();
    assert.equal(await signup.unsubscribe("forged.token"), null);
    const off = setup({ links: false });
    assert.equal(await off.signup.preview("anything"), null);
  });
});
