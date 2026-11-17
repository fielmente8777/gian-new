import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import mongoose, { Types } from "mongoose";

import { SettingsRepository } from "../repositories/settings.repository.js";
import { SubscriberRepository } from "../repositories/subscriber.repository.js";

// The repositories against a real MongoDB, for what the fakes can't prove: nexon's old
// { ndid, email } rows, the filters, the bulk upsert and the stats aggregation.
//
//   mongod --port 27098 --bind_ip 127.0.0.1 --dbpath <empty folder>
//   NEWSLETTER_TEST_MONGO_URI="mongodb://127.0.0.1:27098" npm test
// Skipped when the variable is not set. Refuses anything that isn't localhost, and works in a
// new database named newsletter_test_<random> that it drops afterwards.

const URI = process.env.NEWSLETTER_TEST_MONGO_URI;
const isLocal = (uri: string) => {
  try {
    const hosts = new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).host.split(",");
    return hosts.every((h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h));
  } catch {
    return false;
  }
};
const skip = !URI
  ? "NEWSLETTER_TEST_MONGO_URI not set"
  : !isLocal(URI)
    ? "NEWSLETTER_TEST_MONGO_URI is not localhost"
    : false;

const NOW = new Date("2026-11-16T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
// an ObjectId made at a given time, as nexon's inserts have
const idAt = (date: Date) => Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));

describe("newsletter repositories on MongoDB", { skip }, () => {
  const repo = new SubscriberRepository();
  const settings = new SettingsRepository();
  const dbName = `newsletter_test_${randomUUID().slice(0, 8)}`;
  const raw = () => mongoose.connection.collection("Newsletters");

  before(async () => {
    await mongoose.connect(URI!, { dbName, serverSelectionTimeoutMS: 5000 });
  });
  after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await raw().deleteMany({});
    await mongoose.connection.collection("newsletter_settings").deleteMany({});
  });

  it("reads nexon's bare rows as subscribed website signups dated by their _id", async () => {
    const at = daysAgo(3);
    await raw().insertOne({ _id: idAt(at), ndid: "n1", email: "Old@Mail.com" });
    const page = await repo.list("n1", { status: "subscribed", source: "website" }, 1, 10);
    assert.equal(page.total, 1);
    const [row] = page.items;
    assert.equal(row?.status, "subscribed");
    assert.equal(row?.source, "website");
    assert.equal(row?.subscribedAt.getTime(), Math.floor(at.getTime() / 1000) * 1000);
    // found whatever the case
    assert.equal((await repo.byEmail("n1", "old@mail.com"))?.id, row?.id);
  });

  it("filters by status, tag and search, and pages", async () => {
    const a = await repo.insert("n1", { email: "asha@mail.com", name: "Asha", tags: ["vip"], source: "manual" }, NOW);
    await repo.insert("n1", { email: "bob@mail.com", source: "import" }, NOW);
    await repo.insert("n2", { email: "asha@mail.com", source: "manual" }, NOW);
    await repo.setStatus("n1", [a.id], "unsubscribed", "hotel", NOW);

    assert.equal((await repo.list("n1", {}, 1, 10)).total, 2);
    assert.equal((await repo.list("n1", { status: "unsubscribed" }, 1, 10)).items[0]?.email, "asha@mail.com");
    assert.equal((await repo.list("n1", { tag: "vip" }, 1, 10)).total, 1);
    assert.equal((await repo.list("n1", { search: "BOB" }, 1, 10)).total, 1);
    assert.equal((await repo.list("n1", { search: "asha" }, 1, 10)).total, 1);
    assert.equal((await repo.list("n1", {}, 2, 1)).items.length, 1);
    assert.deepEqual(await repo.tags("n1"), ["vip"]);
  });

  it("merges an import: new rows added, existing ones get name and tags, nothing duplicated", async () => {
    await repo.insert("n1", { email: "known@mail.com", tags: ["old"], source: "website" }, daysAgo(10));
    const result = await repo.merge(
      "n1",
      [
        { email: "known@mail.com", name: "Known", tags: ["diwali"] },
        { email: "new@mail.com", name: null, tags: ["diwali"] },
      ],
      "import",
      NOW,
    );
    assert.deepEqual(result, { added: 1, updated: 1 });
    const known = await repo.byEmail("n1", "known@mail.com");
    assert.equal(known?.name, "Known");
    assert.deepEqual(known?.tags.sort(), ["diwali", "old"]);
    assert.equal(known?.source, "website");
    assert.equal((await repo.byEmail("n1", "new@mail.com"))?.source, "import");
    assert.equal(await raw().countDocuments({ ndid: "n1" }), 2);
  });

  it("only changes rows whose status really changes, keeping the first unsubscribe date", async () => {
    const a = await repo.insert("n1", { email: "a@mail.com", source: "manual" }, daysAgo(5));
    assert.equal(await repo.setStatus("n1", [a.id], "unsubscribed", "subscriber", daysAgo(2)), 1);
    assert.equal(await repo.setStatus("n1", [a.id], "unsubscribed", "hotel", NOW), 0);
    const row = await repo.byId("n1", a.id);
    assert.equal(row?.unsubscribedBy, "subscriber");
    assert.equal(row?.unsubscribedAt?.getTime(), daysAgo(2).getTime());
  });

  it("counts totals, the last 30 days, 12 months and sources", async () => {
    await raw().insertOne({ _id: idAt(daysAgo(400)), ndid: "n1", email: "ancient@mail.com" });
    await raw().insertOne({ _id: idAt(daysAgo(40)), ndid: "n1", email: "older@mail.com" });
    await repo.insert("n1", { email: "new@mail.com", source: "manual" }, daysAgo(5));
    const gone = await repo.insert("n1", { email: "gone@mail.com", source: "import" }, daysAgo(60));
    await repo.setStatus("n1", [gone.id], "unsubscribed", "subscriber", daysAgo(1));
    await repo.insert("n1", { email: "lead@mail.com", source: "campaign", status: "unsubscribed" }, daysAgo(1));
    await repo.insert("n2", { email: "other@mail.com", source: "manual" }, NOW);

    const stats = await repo.stats("n1", NOW);
    assert.equal(stats.total, 5);
    assert.equal(stats.subscribed, 3);
    assert.equal(stats.unsubscribed, 2);
    assert.equal(stats.newLast30Days, 1);
    assert.equal(stats.unsubscribedLast30Days, 2);
    assert.equal(stats.months.length, 12);
    assert.equal(stats.months.at(-1)?.month, "2026-11");
    assert.equal(stats.months[0]?.month, "2025-12");
    // November: "new" joined; "gone" and "lead" left. The campaign row never "joined".
    assert.deepEqual(stats.months.at(-1), { month: "2026-11", subscribed: 1, unsubscribed: 2 });
    assert.equal(stats.months.reduce((n, m) => n + m.subscribed, 0), 3); // ancient is older than 12 months
    assert.deepEqual(stats.bySource, { website: 2, manual: 1, import: 1, campaign: 1 });
  });

  it("builds the unique index, and reports when old duplicates block it", async () => {
    assert.equal(await repo.ensureIndexes(), null);
    await mongoose.connection.collection("Newsletters").dropIndexes();
    await raw().insertMany([
      { ndid: "n1", email: "dup@mail.com" },
      { ndid: "n1", email: "dup@mail.com" },
    ]);
    assert.match((await repo.ensureIndexes()) ?? "", /migrate-newsletters/);
  });

  it("saves and reads settings", async () => {
    assert.equal(await settings.get("n1"), null);
    await settings.save("n1", { welcome: { enabled: true, subject: "s", message: "m" }, notifyOnSignup: false }, NOW);
    assert.deepEqual(await settings.get("n1"), {
      welcome: { enabled: true, subject: "s", message: "m" },
      notifyOnSignup: false,
      updatedAt: NOW,
    });
  });
});
