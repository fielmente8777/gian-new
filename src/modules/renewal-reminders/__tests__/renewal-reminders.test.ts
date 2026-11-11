import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { pino } from "pino";

import { FakeMailbox } from "../../admin/__tests__/fakes.js";
import { InMemorySubscriptions } from "../../subscriptions/__tests__/fakes.js";
import { ReminderCalendar } from "../services/reminder-calendar.js";
import { RenewalReminderService } from "../services/renewal-reminder.service.js";
import { DEFAULT_REMINDER_SETTINGS } from "../types/reminders.types.js";
import { FakeWhatsapp, InMemoryReminderLog, InMemoryReminderSettings } from "./fakes.js";

const DAY = 86_400_000;
// 11:00 India time on 11 Nov 2026
const NOW = new Date("2026-11-11T05:30:00Z");

describe("renewal reminders", () => {
  let subscriptions: InMemorySubscriptions;
  let settings: InMemoryReminderSettings;
  let log: InMemoryReminderLog;
  let mailbox: FakeMailbox;
  let whatsapp: FakeWhatsapp;
  let now: Date;
  let service: RenewalReminderService;

  /** a subscription ending `days` from NOW's day, at 18:00 India time */
  const ending = (ndid: string, days: number, extra: Record<string, unknown> = {}) => {
    const record = subscriptions.add(ndid, `Hotel ${ndid}`, 1, "BASIC");
    const endDay = ReminderCalendar.startOfDay(NOW).getTime() + days * DAY;
    Object.assign(record, {
      endDate: new Date(endDay + 18 * 3_600_000),
      status: days >= 0 ? "ACTIVE" : "EXPIRED",
      ...extra,
    });
    return record;
  };

  beforeEach(() => {
    subscriptions = new InMemorySubscriptions();
    settings = new InMemoryReminderSettings();
    settings.value = {
      ...DEFAULT_REMINDER_SETTINGS,
      enabled: true,
      channels: { email: true, whatsapp: true },
      renewUrl: "https://app.eazotel.com/plans",
    };
    log = new InMemoryReminderLog();
    mailbox = new FakeMailbox();
    whatsapp = new FakeWhatsapp();
    now = NOW;
    service = new RenewalReminderService(
      settings,
      log,
      subscriptions,
      async (ndid) => ({
        hotelName: `Hotel ${ndid}`,
        emails: [`${ndid}@hotel.test`, `OWNER-${ndid}@hotel.test`],
        phones: ["98765 43210"],
      }),
      mailbox,
      whatsapp,
      pino({ level: "silent" }),
      () => now,
    );
  });

  it("sends nothing until staff switch reminders on", async () => {
    settings.value.enabled = false;
    ending("a", 7);
    const run = await service.runDue();
    assert.equal(run.skipped, "reminders are switched off");
    assert.equal(mailbox.sent.length, 0);
  });

  it("waits for the send hour, India time", async () => {
    ending("a", 7);
    now = new Date("2026-11-11T02:00:00Z"); // 07:30 India time
    assert.equal((await service.runDue()).skipped, "too early in the day");
    assert.equal(mailbox.sent.length, 0);
  });

  it("reminds on the chosen days before, on and after the end, and on no other day", async () => {
    for (const [ndid, days] of [
      ["d7", 7],
      ["d5", 5],
      ["d1", 1],
      ["d0", 0],
      ["a3", -3],
      ["a2", -2],
    ] as const)
      ending(ndid, days);
    const run = await service.runDue();
    assert.equal(run.sent, 4);
    const reminded = [...new Set(log.rows.map((r) => r.ndid))].sort();
    assert.deepEqual(reminded, ["a3", "d0", "d1", "d7"]);
    assert.deepEqual(log.rows.find((r) => r.ndid === "a3")?.offsetDays, 3);
  });

  it("emails the hotel and its owner and sends the approved WhatsApp template, with the renew link", async () => {
    ending("d7", 7);
    await service.runDue();
    assert.deepEqual(mailbox.sent.map((m) => m.to).sort(), ["d7@hotel.test", "owner-d7@hotel.test"]);
    assert.match(mailbox.sent[0]!.subject, /BASIC plan ends in 7 days/);
    assert.match(mailbox.sent[0]!.text, /https:\/\/app\.eazotel\.com\/plans/);

    assert.equal(whatsapp.sent.length, 1);
    const [message] = whatsapp.sent;
    assert.equal(message!.to, "919876543210", "a 10-digit Indian number gets 91 in front");
    assert.equal(message!.template, "subscription_reminder");
    assert.equal(message!.params.length, 4);
    assert.equal(message!.params[0], "Hotel d7");
    assert.match(message!.params[2]!, /in 7 days/);
    assert.equal(message!.params[3], "https://app.eazotel.com/plans");
  });

  it("after the end, says the services are paused and the data is safe", async () => {
    ending("a1", -1);
    await service.runDue();
    assert.match(mailbox.sent[0]!.subject, /has ended/);
    assert.match(mailbox.sent[0]!.text, /paused until you renew/);
    assert.match(mailbox.sent[0]!.text, /data and settings are safe/);
  });

  it("sends each reminder once, however often it runs", async () => {
    ending("d3", 3);
    await service.runDue();
    now = new Date(NOW.getTime() + 15 * 60_000);
    const again = await service.runDue();
    assert.equal(again.alreadySent, 1);
    assert.equal(again.sent, 0);
    assert.equal(mailbox.sent.length, 2, "two addresses, one email each, once");
  });

  it("skips clients staff stopped (paused, trash), cancelled ones, and auto-renew before the end", async () => {
    ending("paused", 3, { staffStop: { kind: "paused", at: NOW, by: "x", reason: null, remainingMs: 0 } });
    ending("cancelled", 3, { status: "CANCELLED" });
    ending("auto", 3, { autoRenew: true });
    ending("auto-failed", -1, { autoRenew: true });
    await service.runDue();
    assert.deepEqual(
      log.rows.map((r) => r.ndid),
      ["auto-failed"],
      "a failed auto-renewal still gets the after-end reminder",
    );
  });

  it("leaves out trials when told to, and calls a trial a free trial", async () => {
    ending("trial", 1, { status: "TRIAL" });
    settings.value.includeTrial = false;
    await service.runDue();
    assert.equal(log.rows.length, 0);

    settings.value.includeTrial = true;
    await service.runDue();
    assert.match(mailbox.sent[0]!.subject, /free trial ends in 1 day/);
  });

  it("keeps the email when WhatsApp refuses, and logs both results", async () => {
    whatsapp.failing = true;
    ending("d1", 1);
    const run = await service.runDue();
    assert.equal(run.sent, 1);
    const [row] = log.rows;
    assert.equal(row!.email.status, "sent");
    assert.equal(row!.whatsapp.status, "failed");
    assert.match(row!.whatsapp.note ?? "", /Template name does not exist/);
  });

  it("with no WhatsApp number on the server, sends email only and says why", async () => {
    service = new RenewalReminderService(
      settings,
      log,
      subscriptions,
      async () => ({ hotelName: "H", emails: ["h@hotel.test"], phones: ["9876543210"] }),
      mailbox,
      null,
      pino({ level: "silent" }),
      () => now,
    );
    ending("d1", 1);
    await service.runDue();
    assert.equal(log.rows[0]!.whatsapp.status, "skipped");
    assert.match(log.rows[0]!.whatsapp.note ?? "", /not set up on the server/);
  });

  it("staff can send one by hand at any time, even with reminders switched off", async () => {
    settings.value.enabled = false;
    ending("x", 12);
    const entry = await service.sendNow("x", "boss@eazotel.com");
    assert.equal(entry.kind, "manual");
    assert.equal(entry.by, "boss@eazotel.com");
    assert.equal(entry.offsetDays, -12);
    assert.equal(mailbox.sent.length, 2);
    await assert.rejects(service.sendNow("nobody", "boss@eazotel.com"), { code: "SUBSCRIPTION_NOT_FOUND" });
  });

  it("previews who gets what in the coming days", async () => {
    ending("soon", 8);
    const upcoming = await service.upcoming(7);
    // 8 days left: "7 days left" goes out tomorrow and "3 days left" in 5 days
    assert.deepEqual(
      upcoming.map((u) => u.offsetDays),
      [-7, -3],
    );
    assert.equal(upcoming[0]!.sendOn.getTime(), ReminderCalendar.startOfDay(NOW).getTime() + DAY);
    assert.equal(upcoming[1]!.sendOn.getTime(), ReminderCalendar.startOfDay(NOW).getTime() + 5 * DAY);
  });

  it("saves the schedule cleaned up: no repeats, in order", async () => {
    const saved = await service.saveSettings(
      { ...settings.value, daysBefore: [1, 7, 3, 7], daysAfter: [7, 1, 1] },
      "boss@eazotel.com",
    );
    assert.deepEqual(saved.daysBefore, [7, 3, 1]);
    assert.deepEqual(saved.daysAfter, [1, 7]);
    assert.equal(saved.updatedBy, "boss@eazotel.com");
  });
});
