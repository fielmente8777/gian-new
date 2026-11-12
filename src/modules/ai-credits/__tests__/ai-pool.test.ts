import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { CostSyncBusyError, OpenAiNotConfiguredError } from "../errors/ai-credits.errors.js";
import { UtcDays } from "../services/utc-days.js";
import { TestAiCredits } from "./fakes.js";

const NOW = new Date("2026-11-11T09:30:00Z");
const TODAY = "2026-11-11";
const day = (offset: number) => UtcDays.add(TODAY, offset);

describe("UtcDays", () => {
  it("counts whole UTC days", () => {
    assert.equal(UtcDays.of(new Date("2026-11-11T23:59:59Z")), "2026-11-11");
    assert.equal(UtcDays.add("2026-03-01", -1), "2026-02-28");
    assert.deepEqual(UtcDays.range("2026-12-30", "2027-01-01"), ["2026-12-30", "2026-12-31", "2027-01-01"]);
    assert.equal(UtcDays.unix("1970-01-02"), 86_400);
    assert.ok(UtcDays.isDate("2026-02-28"));
    assert.ok(!UtcDays.isDate("2026-02-30"));
  });
});

describe("OpenAI pool", () => {
  let t: TestAiCredits;
  beforeEach(() => {
    t = TestAiCredits.create();
  });

  it("is unknown until a top-up is recorded", async () => {
    t.costs.rows.push({ date: day(-1), lineItem: "x", projectId: null, amountUsd: 3 });
    const o = await t.port.pool.overview(NOW);
    assert.equal(o.openai.trackedSince, null);
    assert.equal(o.openai.remainingUsd, null);
    assert.equal(o.openai.runwayDays, null);
    assert.deepEqual(o.alerts, []);
  });

  it("remaining = top-ups - spend since the first top-up; runway from the last 7 full days", async () => {
    await t.topUps.create({ amountUsd: 100, paidOn: day(-10), note: "opening balance" }, "boss@eazotel.com", NOW);
    await t.topUps.create({ amountUsd: 50, paidOn: day(-2), note: null }, "boss@eazotel.com", NOW);
    // spend before tracking started is not counted
    t.costs.rows.push({ date: day(-20), lineItem: "x", projectId: null, amountUsd: 999 });
    for (let i = 1; i <= 7; i++) t.costs.rows.push({ date: day(-i), lineItem: "x", projectId: null, amountUsd: 2 });
    t.costs.rows.push({ date: TODAY, lineItem: "x", projectId: null, amountUsd: 1 });

    const o = await t.port.pool.overview(NOW);
    assert.equal(o.openai.topUpsUsd, 150);
    assert.equal(o.openai.trackedSince, day(-10));
    assert.equal(o.openai.spentUsd, 15);
    assert.equal(o.openai.remainingUsd, 135);
    assert.equal(o.openai.avgDailyUsd, 2);
    assert.equal(o.openai.runwayDays, 67.5);
    assert.equal(o.openai.spend.todayUsd, 1);
    assert.equal(o.openai.spend.last7Usd, 13);
  });

  it("works out what unused client credits would cost at OpenAI", async () => {
    t.wallets.seed("a", 3000, 1000);
    t.wallets.seed("b", 5000);
    await t.catalogue.createPricing(
      {
        provider: "openai",
        model: "m1",
        inputPrice: 1,
        outputPrice: 1,
        embeddingPrice: 0,
        requestPrice: 0,
        currency: "USD",
        creditConversionRate: 1000,
        status: "active",
      },
      { email: "x", ip: null },
    );
    await t.catalogue.createPricing(
      {
        provider: "openai",
        model: "m2",
        inputPrice: 1,
        outputPrice: 1,
        embeddingPrice: 0,
        requestPrice: 0,
        currency: "USD",
        creditConversionRate: 3000,
        status: "active",
      },
      { email: "x", ip: null },
    );
    await t.topUps.create({ amountUsd: 5, paidOn: TODAY, note: null }, "x", NOW);
    const o = await t.port.pool.overview(NOW);
    assert.equal(o.credits.available, 7000);
    assert.equal(o.coverage.creditsPerUsd, 2000);
    assert.equal(o.coverage.liabilityUsd, 3.5);
    assert.equal(o.coverage.ratio, 1.43);
  });

  it("flags low pool and short runway against the settings", async () => {
    await t.topUps.create({ amountUsd: 30, paidOn: day(-7), note: null }, "x", NOW);
    for (let i = 1; i <= 7; i++) t.costs.rows.push({ date: day(-i), lineItem: "x", projectId: null, amountUsd: 2 });
    const o = await t.port.pool.overview(NOW);
    assert.equal(o.openai.remainingUsd, 16);
    assert.deepEqual(o.alerts, ["low_pool"]);
    t.state.settings.lowPoolUsd = 10;
    t.state.settings.lowRunwayDays = 10;
    assert.deepEqual((await t.port.pool.overview(NOW)).alerts, ["low_runway"]);
  });

  it("reconciles OpenAI's bill with what gian tracked, day by day", async () => {
    t.costs.rows.push({ date: day(-1), lineItem: "gpt-5-mini, input", projectId: null, amountUsd: 4 });
    t.costs.rows.push({ date: day(-1), lineItem: "embeddings", projectId: null, amountUsd: 1 });
    t.tracked.days.push({ date: day(-1), trackedUsd: 3.5, billedUsd: 3, calls: 40 });
    const r = await t.port.pool.reconcile(7, NOW);
    assert.equal(r.days.length, 7);
    assert.equal(r.from, day(-6));
    const y = r.days.find((d) => d.date === day(-1))!;
    assert.deepEqual(y, { date: day(-1), openaiUsd: 5, trackedUsd: 3.5, billedUsd: 3, gapUsd: 1.5, calls: 40 });
    assert.equal(r.totals.gapUsd, 1.5);
    assert.equal(r.lineItems.length, 2);
  });
});

describe("OpenAI cost sync", () => {
  let t: TestAiCredits;
  beforeEach(() => {
    t = TestAiCredits.create();
  });

  it("backfills 30 days on the first run, then re-fetches the last 3", async () => {
    t.openai.add(day(-40), 9);
    t.openai.add(day(-29), 1);
    t.openai.add(day(-1), 2);
    const first = await t.port.sync.run(NOW);
    assert.equal(first.from, day(-29));
    assert.equal(first.to, TODAY);
    assert.equal(first.rows, 2);
    assert.equal(t.openai.calls[0]!.startTime, UtcDays.unix(day(-29)));
    assert.equal(t.openai.calls[0]!.endTime, UtcDays.unix(day(1)));

    const second = await t.port.sync.run(new Date("2026-11-12T01:00:00Z"));
    // latest saved day is 2026-11-10 (day -1): fetch from two days before it
    assert.equal(second.from, day(-3));
  });

  it("is idempotent: running twice leaves the same rows, and revised days replace old ones", async () => {
    t.openai.add(day(-1), 2);
    t.openai.add(day(-1), 0.5, "embeddings");
    await t.port.sync.run(NOW);
    await t.port.sync.run(NOW);
    assert.equal(t.costs.rows.length, 2);
    assert.equal(await t.costs.sumSince(day(-1)), 2.5);

    // OpenAI revises yesterday: the embeddings line is gone, the model line grew
    t.openai.lines = [];
    t.openai.add(day(-1), 3);
    await t.port.sync.run(NOW);
    assert.equal(t.costs.rows.length, 1);
    assert.equal(await t.costs.sumSince(day(-1)), 3);
  });

  it("adds up lines OpenAI split for the same day, item and project", async () => {
    t.openai.add(day(-1), 1);
    t.openai.add(day(-1), 2);
    await t.port.sync.run(NOW);
    assert.equal(t.costs.rows.length, 1);
    assert.equal(t.costs.rows[0]!.amountUsd, 3);
  });

  it("only one server syncs at a time", async () => {
    await t.state.acquireLock("cost-sync", "other-server", new Date(NOW.getTime() + 60_000), NOW);
    await assert.rejects(t.port.sync.run(NOW), CostSyncBusyError);
    // an expired lock is taken over
    await t.port.sync.run(new Date(NOW.getTime() + 120_000));
    assert.equal(t.state.locks.size, 0, "released after the run");
  });

  it("records a failed sync and releases the lock", async () => {
    t.openai.fail = Object.assign(new Error("boom"), { code: "OPENAI_ADMIN_KEY_REJECTED" });
    await assert.rejects(t.port.sync.run(NOW));
    assert.equal(t.state.sync?.ok, false);
    assert.equal(t.state.sync?.error, "OPENAI_ADMIN_KEY_REJECTED");
    assert.equal(t.state.locks.size, 0);
  });

  it("says so when the admin key is not set", async () => {
    const off = TestAiCredits.create({ openai: false });
    await assert.rejects(off.port.sync.run(NOW), OpenAiNotConfiguredError);
    assert.equal((await off.port.pool.overview(NOW)).openai.configured, false);
  });
});

describe("low pool alerts", () => {
  it("emails super admins and extra addresses once per 24 hours per condition", async () => {
    const t = TestAiCredits.create({ recipients: ["boss@eazotel.com", "cto@eazotel.com"] });
    t.state.settings.alertEmails = ["finance@eazotel.com", "boss@eazotel.com"];
    await t.topUps.create({ amountUsd: 10, paidOn: day(-5), note: null }, "x", NOW);
    t.openai.add(day(-1), 2);

    await t.port.sync.run(NOW);
    assert.deepEqual(t.mailer.sent.map((m) => m.to).sort(), [
      "boss@eazotel.com",
      "cto@eazotel.com",
      "finance@eazotel.com",
    ]);
    assert.match(t.mailer.sent[0]!.text, /Remaining \(top-ups minus spend\): \$8\.00/);
    assert.match(t.mailer.sent[0]!.text, /https:\/\/admin\.example\.test\/ai-credits/);

    // six hours later: still low, but already sent today
    await t.port.sync.run(new Date(NOW.getTime() + 6 * 3_600_000));
    assert.equal(t.mailer.sent.length, 3);

    // a day later it goes again
    await t.port.sync.run(new Date(NOW.getTime() + 25 * 3_600_000));
    assert.equal(t.mailer.sent.length, 6);
  });

  it("sends nothing while the pool is healthy", async () => {
    const t = TestAiCredits.create();
    await t.topUps.create({ amountUsd: 500, paidOn: day(-5), note: null }, "x", NOW);
    t.openai.add(day(-1), 2);
    await t.port.sync.run(NOW);
    assert.equal(t.mailer.sent.length, 0);
  });
});
