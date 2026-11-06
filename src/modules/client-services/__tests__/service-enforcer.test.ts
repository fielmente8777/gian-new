import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { TestServiceControl } from "./fakes.js";

describe("ServiceEnforcer", () => {
  let t: ReturnType<typeof TestServiceControl.create>;

  beforeEach(() => {
    t = TestServiceControl.create();
  });

  it("a client with no subscription and no switches keeps everything", async () => {
    const effective = await t.enforcer.effective("new");
    assert.equal(effective.subscriptionServing, true);
    assert.equal(effective.chatbot, true);
    assert.equal(effective.leads, true);
  });

  it("an ended subscription stops nothing unless followExpiry is on", async () => {
    t.subscriptions.add("old", "Old Hotel", -30);
    assert.equal((await t.enforcer.effective("old")).leads, true);

    const strict = TestServiceControl.create(t.subscriptions, true);
    assert.equal((await strict.enforcer.effective("old")).leads, false);
  });

  it("the sweep sends the catch-up email once a hotel pays elsewhere, and only once", async () => {
    t.subscriptions.add("aaa", "Amaltas", 10);
    await t.subscriptions.pause("aaa", "boss@eazotel.com", null, new Date());
    t.store.addAlert("aaa", "Asha");
    await t.enforcer.sweep();
    assert.equal(t.mailbox.sent.length, 0, "still paused");

    // the hotel renews by paying in gian: nothing calls gian-new
    await t.subscriptions.renew("aaa", new Date(Date.now() + 30 * 86_400_000), null);
    await t.enforcer.sweep();
    await t.enforcer.sweep();
    assert.equal(t.mailbox.sent.length, 1);
    assert.equal(t.store.alerts.length, 0);
  });

  it("where mail only goes to the logs, leads are released but the alerts wait for a real mailer", async () => {
    t.mailbox.delivers = false;
    t.store.addAlert("aaa", "Asha");
    const result = await t.enforcer.apply("aaa");
    assert.ok(result.released);
    assert.equal(result.emailed, 0);
    assert.equal(t.store.alerts.length, 1);
  });

  it("the sweep gives a paused chatbot back once its client may have it again", async () => {
    t.store.chatbots.set("aaa", { active: true, paused: true });
    await t.enforcer.sweep();
    assert.equal(t.store.chatbots.get("aaa")?.paused, false);
  });
});
