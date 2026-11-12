import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import mongoose from "mongoose";

import {
  IdempotencyKeyReusedError,
  InsufficientCreditsError,
  DuplicatePricingError,
} from "../errors/ai-credits.errors.js";
import {
  AiAdminAuditLog,
  AiCreditSettings,
  AiCreditTransaction,
  AiPricing,
  AiWallet,
} from "../models/gian-ai-credits.models.js";
import { CreditCatalogueRepository } from "../repositories/credit-catalogue.repository.js";
import { PoolStateRepository, ProviderCostRepository } from "../repositories/openai-pool.repositories.js";
import { WalletLedgerRepository } from "../repositories/wallet-ledger.repository.js";

// The repositories against a real MongoDB, for what fakes can't prove: transactions, the
// "never below available" guard under concurrent requests, unique keys and the lock.
//
// Needs a LOCAL replica set (transactions don't run on a standalone mongod):
//   mongod --replSet rs0 --port 27099 --bind_ip 127.0.0.1 --dbpath <empty folder>
//   then once: rs.initiate()
//   AI_CREDITS_TEST_MONGO_URI="mongodb://127.0.0.1:27099/?replicaSet=rs0" npm test
// Skipped when the variable is not set. Refuses anything that isn't localhost, and works in a
// new database named ai_credits_test_<random> that it drops afterwards.

const URI = process.env.AI_CREDITS_TEST_MONGO_URI;
const isLocal = (uri: string) => {
  try {
    const hosts = new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).host.split(",");
    return hosts.every((h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h));
  } catch {
    return false;
  }
};
const skip = !URI
  ? "AI_CREDITS_TEST_MONGO_URI not set"
  : !isLocal(URI)
    ? "AI_CREDITS_TEST_MONGO_URI is not localhost"
    : false;

const actor = { email: "manager@eazotel.com", ip: "10.0.0.1" };

describe("ai-credits repositories on MongoDB", { skip }, () => {
  const wallets = new WalletLedgerRepository();
  const dbName = `ai_credits_test_${randomUUID().slice(0, 8)}`;

  before(async () => {
    await mongoose.connect(URI!, { dbName, serverSelectionTimeoutMS: 5000 });
    // gian builds these on the real database; here we build them ourselves
    for (const model of [AiWallet, AiCreditTransaction, AiPricing, AiCreditSettings]) await model.createIndexes();
  });
  after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    for (const name of [
      "aiwallets",
      "aicredittransactions",
      "aiadminauditlogs",
      "aipricings",
      "ai_credits_state",
      "ai_provider_cost_daily",
    ]) {
      await mongoose.connection.collection(name).deleteMany({});
    }
  });

  const seed = (tenantId: string, balance: number, reservedCredits = 0) =>
    AiWallet.create({ tenantId, balance, reservedCredits });

  it("ten staff deducting at once can never take more than is available", async () => {
    await seed("corbett", 100);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        wallets.adjust(
          { ndid: "corbett", direction: "deduct", amount: 30, reason: "test", idempotencyKey: `deduct-${i}-xxxx` },
          actor,
        ),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 3);
    assert.ok(refused.every((r) => r.status === "rejected" && r.reason instanceof InsufficientCreditsError));
    const wallet = await wallets.find("corbett");
    assert.equal(wallet.balance, 10);
    assert.equal(wallet.totalAdjustedOut, 90);
    assert.equal(await AiCreditTransaction.countDocuments({ tenantId: "corbett" }), 3);
    assert.equal(await AiAdminAuditLog.countDocuments({ tenantId: "corbett", action: "credits.deduct" }), 3);
    // every ledger row's before/after chain adds up
    const rows = await AiCreditTransaction.find({ tenantId: "corbett" }).sort({ balanceBefore: -1 }).lean();
    assert.deepEqual(
      rows.map((r) => [r.balanceBefore, r.balanceAfter]),
      [
        [100, 70],
        [70, 40],
        [40, 10],
      ],
    );
  });

  it("credits held by running AI requests can't be deducted", async () => {
    await seed("corbett", 100, 80);
    await assert.rejects(
      wallets.adjust(
        { ndid: "corbett", direction: "deduct", amount: 30, reason: "test", idempotencyKey: "held-0001" },
        actor,
      ),
      (e) => e instanceof InsufficientCreditsError && e.available === 20,
    );
  });

  it("the same key sent five times at once adds the credits once", async () => {
    await seed("corbett", 0);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        wallets.adjust(
          { ndid: "corbett", direction: "add", amount: 50, reason: "bonus", idempotencyKey: "same-key-0001" },
          actor,
        ),
      ),
    );
    assert.equal(new Set(results.map((r) => r.transactionId)).size, 1);
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    assert.equal((await wallets.find("corbett")).balance, 50);
  });

  it("refuses a key already used for another client", async () => {
    await wallets.adjust(
      { ndid: "a", direction: "add", amount: 1, reason: "bonus", idempotencyKey: "shared-0001" },
      actor,
    );
    await assert.rejects(
      wallets.adjust({ ndid: "b", direction: "add", amount: 1, reason: "bonus", idempotencyKey: "shared-0001" }, actor),
      IdempotencyKeyReusedError,
    );
  });

  it("writes the ledger and audit rows exactly as gian's adjustCredits does", async () => {
    const r = await wallets.adjust(
      { ndid: "corbett", direction: "add", amount: 25, reason: "Launch offer", idempotencyKey: "shape-0001" },
      actor,
    );
    const tx = await AiCreditTransaction.findById(r.transactionId).lean();
    const { _id, createdAt, ...ledger } = tx!;
    assert.ok(createdAt instanceof Date);
    assert.deepEqual(ledger, {
      tenantId: "corbett",
      type: "adjustment",
      amount: 25,
      balanceBefore: 0,
      balanceAfter: 25,
      service: null,
      description: "Launch offer",
      referenceId: "shape-0001",
      idempotencyKey: "adjustment:shape-0001",
      performedBy: "manager@eazotel.com",
    });
    const audit = await AiAdminAuditLog.findOne({ target: r.transactionId }).lean();
    const { _id: _a, createdAt: _c, ...row } = audit!;
    assert.deepEqual(row, {
      actor: "manager@eazotel.com",
      action: "credits.add",
      ip: "10.0.0.1",
      tenantId: "corbett",
      target: r.transactionId,
      before: { balance: 0 },
      after: { balance: 25 },
      reason: "Launch offer",
    });
    // gian's defaults on the wallet it created
    const wallet = await AiWallet.findOne({ tenantId: "corbett" }).lean();
    assert.equal(wallet!.status, "active");
    assert.equal(wallet!.currency, "INR");
  });

  it("pricing: one row per provider and model; settings created with gian's defaults", async () => {
    const catalogue = new CreditCatalogueRepository();
    const input = {
      provider: "openai",
      model: "gpt-5-mini",
      inputPrice: 0.25,
      outputPrice: 2,
      embeddingPrice: 0,
      requestPrice: 0,
      currency: "USD",
      creditConversionRate: 1000,
      status: "active" as const,
    };
    const row = await catalogue.createPricing(input, actor);
    await assert.rejects(catalogue.createPricing(input, actor), DuplicatePricingError);
    const changed = await catalogue.updatePricing(row.id, { creditConversionRate: 1200 }, actor);
    assert.equal(changed?.before.creditConversionRate, 1000);
    assert.equal(changed?.after.creditConversionRate, 1200);
    assert.equal(changed?.after.updatedBy, "manager@eazotel.com");

    const settings = await catalogue.getSettings();
    assert.equal(settings.lowThreshold, 1000);
    assert.equal(settings.chatReserveCredits, 25);
    assert.deepEqual(
      (await AiAdminAuditLog.find().sort({ _id: 1 }).lean()).map((a) => a.action),
      ["pricing.create", "pricing.update"],
    );
  });

  it("the sync lock lets one holder in until it expires", async () => {
    const state = new PoolStateRepository();
    const now = new Date();
    const later = new Date(now.getTime() + 60_000);
    assert.equal(await state.acquireLock("cost-sync", "a", later, now), true);
    assert.equal(await state.acquireLock("cost-sync", "b", later, now), false);
    assert.equal(
      await state.acquireLock("cost-sync", "b", new Date(later.getTime() + 60_000), new Date(later.getTime() + 1)),
      true,
    );
    await state.releaseLock("cost-sync", "a"); // not a's any more: no effect
    assert.equal(await state.acquireLock("cost-sync", "c", later, now), false);
    await state.releaseLock("cost-sync", "b");
    assert.equal(await state.acquireLock("cost-sync", "c", later, now), true);
  });

  it("cost days are replaced as a whole, so syncing twice changes nothing", async () => {
    const costs = new ProviderCostRepository();
    const at = new Date();
    const rows = [
      { date: "2026-11-10", lineItem: "gpt-5-mini, input", projectId: "p1", amountUsd: 2 },
      { date: "2026-11-10", lineItem: "embeddings", projectId: null, amountUsd: 0.5 },
    ];
    await costs.replaceDays(["2026-11-10"], rows, at);
    await costs.replaceDays(["2026-11-10"], rows, at);
    assert.equal(await costs.sumSince("2026-11-01"), 2.5);
    await costs.replaceDays(["2026-11-10", "2026-11-11"], [{ ...rows[0]!, amountUsd: 3 }], at);
    assert.equal(await costs.sumSince("2026-11-01"), 3);
    assert.equal(await costs.latestDate(), "2026-11-10");
  });
});
