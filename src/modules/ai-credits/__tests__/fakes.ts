import { pino } from "pino";

import type { Mailer, MailMessage } from "../../../integrations/mail/mailer.js";
import { AiCreditsModule, type AiCreditsPort } from "../ai-credits.module.js";
import {
  DuplicatePricingError,
  IdempotencyKeyReusedError,
  InsufficientCreditsError,
} from "../errors/ai-credits.errors.js";
import {
  DEFAULT_POOL_SETTINGS,
  type Actor,
  type Adjustment,
  type AdjustmentResult,
  type Changed,
  type CreditCatalogueStore,
  type CreditPackage,
  type CreditSettings,
  type DailyCost,
  type GianAuditEntry,
  type GianAuditStore,
  type LedgerEntry,
  type LedgerPage,
  type OpenAiCosts,
  type PackageInput,
  type PoolAlertKind,
  type PoolSettings,
  type PoolSettingsInput,
  type PoolStateStore,
  type PricingInput,
  type PricingRow,
  type ProviderCostStore,
  type SyncStatus,
  type TopUp,
  type TopUpInput,
  type TopUpStore,
  type TrackedCostDay,
  type TrackedCostStore,
  type UsageSummary,
  type WalletStatus,
  type WalletStore,
  type WalletTotals,
  type WalletView,
} from "../types/ai-credits.types.js";

let ids = 1;
const nextId = () => (ids++).toString(16).padStart(24, "0");

/** gian's aiadminauditlogs, in memory; the wallet and catalogue fakes write to it like the repositories. */
export class InMemoryGianAudit implements GianAuditStore {
  readonly rows: GianAuditEntry[] = [];

  add(actor: Actor, action: string, data: Partial<GianAuditEntry>): void {
    this.rows.push({
      id: nextId(),
      actor: actor.email,
      action,
      tenantId: data.tenantId ?? null,
      target: data.target ?? null,
      before: data.before ?? null,
      after: data.after ?? null,
      reason: data.reason ?? null,
      ip: actor.ip,
      createdAt: new Date(),
    });
  }

  async list({ limit, tenantId }: { limit: number; before?: string; tenantId?: string }) {
    const items = this.rows
      .filter((r) => !tenantId || r.tenantId === tenantId)
      .reverse()
      .slice(0, limit);
    return { items, nextCursor: null };
  }
}

/** Wallets with the repository's rules: available = balance - reserved, keys apply once. */
export class InMemoryWallets implements WalletStore {
  readonly wallets = new Map<string, WalletView>();
  readonly ledgerRows: (LedgerEntry & { ndid: string; key: string })[] = [];
  usageByNdid = new Map<string, UsageSummary>();

  constructor(private readonly audit: InMemoryGianAudit) {}

  seed(ndid: string, balance: number, reservedCredits = 0, status: WalletStatus = "active"): void {
    this.wallets.set(ndid, {
      ...InMemoryWallets.empty(ndid),
      exists: true,
      balance,
      reservedCredits,
      status,
      available: Math.max(0, balance - reservedCredits),
    });
  }

  static empty(ndid: string): WalletView {
    return {
      ndid,
      exists: false,
      balance: 0,
      reservedCredits: 0,
      available: 0,
      totalPurchased: 0,
      totalUsed: 0,
      totalAdjustedIn: 0,
      totalAdjustedOut: 0,
      status: "active",
      lastRechargeAt: null,
    };
  }

  async find(ndid: string) {
    return { ...(this.wallets.get(ndid) ?? InMemoryWallets.empty(ndid)) };
  }

  async findMany(ndids: string[]) {
    return new Map(ndids.map((n) => [n, this.wallets.get(n) ?? InMemoryWallets.empty(n)]));
  }

  async totals(): Promise<WalletTotals> {
    const all = [...this.wallets.values()];
    const sum = (k: keyof WalletView) => all.reduce((s, w) => s + Number(w[k]), 0);
    return {
      wallets: all.length,
      suspended: all.filter((w) => w.status === "suspended").length,
      balance: sum("balance"),
      reserved: sum("reservedCredits"),
      available: sum("available"),
      totalPurchased: sum("totalPurchased"),
      totalUsed: sum("totalUsed"),
    };
  }

  async lowest(limit: number, below: number) {
    return [...this.wallets.values()]
      .filter((w) => w.available < below)
      .sort((a, b) => a.available - b.available)
      .slice(0, limit);
  }

  async ledger(ndid: string, { limit }: { limit: number }): Promise<LedgerPage> {
    return {
      items: this.ledgerRows
        .filter((r) => r.ndid === ndid)
        .reverse()
        .slice(0, limit),
      nextCursor: null,
    };
  }

  async usage(ndid: string, from: Date): Promise<UsageSummary> {
    return (
      this.usageByNdid.get(ndid) ?? {
        from,
        credits: 0,
        uncollectedCredits: 0,
        tokens: 0,
        costUsd: 0,
        operations: 0,
        byService: [],
        byModel: [],
      }
    );
  }

  async adjust(a: Adjustment, actor: Actor): Promise<AdjustmentResult> {
    const key = `adjustment:${a.idempotencyKey}`;
    const done = this.ledgerRows.find((r) => r.key === key);
    if (done) {
      if (done.ndid !== a.ndid) throw new IdempotencyKeyReusedError();
      return {
        transactionId: done.id,
        balanceBefore: done.balanceBefore,
        balanceAfter: done.balanceAfter,
        replayed: true,
      };
    }
    const w = this.wallets.get(a.ndid) ?? { ...InMemoryWallets.empty(a.ndid), exists: true };
    if (a.direction === "deduct" && w.balance - w.reservedCredits < a.amount)
      throw new InsufficientCreditsError(w.available);
    const amount = a.direction === "add" ? a.amount : -a.amount;
    const before = w.balance;
    const after = before + amount;
    const next: WalletView = {
      ...w,
      exists: true,
      balance: after,
      available: Math.max(0, after - w.reservedCredits),
      totalAdjustedIn: w.totalAdjustedIn + (amount > 0 ? amount : 0),
      totalAdjustedOut: w.totalAdjustedOut + (amount < 0 ? -amount : 0),
    };
    this.wallets.set(a.ndid, next);
    const id = nextId();
    this.ledgerRows.push({
      id,
      ndid: a.ndid,
      key,
      type: "adjustment",
      amount,
      balanceBefore: before,
      balanceAfter: after,
      service: null,
      description: a.reason,
      referenceId: a.idempotencyKey,
      performedBy: actor.email,
      createdAt: new Date(),
    });
    this.audit.add(actor, amount > 0 ? "credits.add" : "credits.deduct", {
      tenantId: a.ndid,
      target: id,
      before: { balance: before },
      after: { balance: after },
      reason: a.reason,
    });
    return { transactionId: id, balanceBefore: before, balanceAfter: after, replayed: false };
  }

  async setStatus(ndid: string, status: WalletStatus, reason: string, actor: Actor) {
    const w = this.wallets.get(ndid) ?? { ...InMemoryWallets.empty(ndid), exists: true };
    this.wallets.set(ndid, { ...w, status });
    this.audit.add(actor, "wallet.status", { tenantId: ndid, before: { status: w.status }, after: { status }, reason });
    return { before: w.status };
  }
}

export const DEFAULT_CREDIT_SETTINGS: CreditSettings = {
  enabled: false,
  lowThreshold: 1000,
  criticalThreshold: 250,
  chatReserveCredits: 25,
  reserveMultiplier: 1.25,
  reservationTtlMinutes: 30,
  fallbackCreditsPer1kTokens: 1,
  fallbackCreditsPerRequest: 1,
};

export class InMemoryCatalogue implements CreditCatalogueStore {
  readonly pricing: PricingRow[] = [];
  readonly packages: CreditPackage[] = [];
  settings: CreditSettings = { ...DEFAULT_CREDIT_SETTINGS };

  constructor(private readonly audit: InMemoryGianAudit) {}

  async listPricing() {
    return this.pricing.map((p) => ({ ...p }));
  }

  async createPricing(input: PricingInput, actor: Actor) {
    if (this.pricing.some((p) => p.provider === input.provider && p.model === input.model))
      throw new DuplicatePricingError();
    const row: PricingRow = { ...input, id: nextId(), updatedAt: new Date(), updatedBy: actor.email };
    this.pricing.push(row);
    this.audit.add(actor, "pricing.create", { target: `${input.provider}/${input.model}`, after: input });
    return { ...row };
  }

  async updatePricing(id: string, changes: Partial<PricingInput>, actor: Actor): Promise<Changed<PricingRow> | null> {
    const i = this.pricing.findIndex((p) => p.id === id);
    if (i < 0) return null;
    const before = this.pricing[i]!;
    const after = { ...before, ...changes, updatedBy: actor.email };
    this.pricing[i] = after;
    this.audit.add(actor, "pricing.update", { target: `${before.provider}/${before.model}`, before, after: changes });
    return { before, after };
  }

  async listPackages() {
    return this.packages.map((p) => ({ ...p }));
  }

  async createPackage(input: PackageInput, actor: Actor) {
    if (input.popular) for (const p of this.packages) p.popular = false;
    const pack: CreditPackage = { ...input, id: nextId(), updatedAt: new Date() };
    this.packages.push(pack);
    this.audit.add(actor, "package.create", { target: pack.id, after: input });
    return { ...pack };
  }

  async updatePackage(
    id: string,
    changes: Partial<PackageInput>,
    actor: Actor,
  ): Promise<Changed<CreditPackage> | null> {
    const i = this.packages.findIndex((p) => p.id === id);
    if (i < 0) return null;
    if (changes.popular) for (const p of this.packages) p.popular = false;
    const before = this.packages[i]!;
    const after = { ...before, ...changes };
    this.packages[i] = after;
    this.audit.add(actor, "package.update", { target: id, before, after: changes });
    return { before, after };
  }

  async getSettings() {
    return { ...this.settings };
  }

  async updateSettings(changes: Partial<CreditSettings>, actor: Actor) {
    const before = { ...this.settings };
    this.settings = { ...this.settings, ...changes };
    this.audit.add(actor, "settings.update", { before, after: changes });
    return { before, after: { ...this.settings } };
  }
}

export class InMemoryProviderCosts implements ProviderCostStore {
  rows: DailyCost[] = [];

  async latestDate() {
    return (
      this.rows
        .map((r) => r.date)
        .sort()
        .at(-1) ?? null
    );
  }

  async replaceDays(days: string[], rows: DailyCost[]) {
    this.rows = [...this.rows.filter((r) => !days.includes(r.date)), ...rows.map((r) => ({ ...r }))];
  }

  async dailyTotals(from: string, to: string) {
    const byDay = new Map<string, number>();
    for (const r of this.rows)
      if (r.date >= from && r.date <= to) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.amountUsd);
    return [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, amountUsd]) => ({ date, amountUsd }));
  }

  async lineItems(from: string, to: string) {
    const byItem = new Map<string, number>();
    for (const r of this.rows)
      if (r.date >= from && r.date <= to) byItem.set(r.lineItem, (byItem.get(r.lineItem) ?? 0) + r.amountUsd);
    return [...byItem].map(([lineItem, amountUsd]) => ({ lineItem, amountUsd }));
  }

  async sumSince(from: string) {
    return this.rows.filter((r) => r.date >= from).reduce((s, r) => s + r.amountUsd, 0);
  }
}

export class InMemoryTrackedCosts implements TrackedCostStore {
  days: TrackedCostDay[] = [];

  async daily(from: Date, to: Date) {
    const f = from.toISOString().slice(0, 10);
    const t = to.toISOString().slice(0, 10);
    return this.days.filter((d) => d.date >= f && d.date < t);
  }
}

export class InMemoryTopUps implements TopUpStore {
  readonly rows: TopUp[] = [];

  async list() {
    return [...this.rows].sort((a, b) => b.paidOn.localeCompare(a.paidOn));
  }

  async create(input: TopUpInput, by: string, now: Date) {
    const row: TopUp = { ...input, id: nextId(), createdBy: by, createdAt: now, updatedBy: null, updatedAt: null };
    this.rows.push(row);
    return { ...row };
  }

  async update(id: string, changes: Partial<TopUpInput>, by: string, now: Date) {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const before = this.rows[i]!;
    const after = { ...before, ...changes, updatedBy: by, updatedAt: now };
    this.rows[i] = after;
    return { before, after };
  }
}

export class InMemoryPoolState implements PoolStateStore {
  settings: PoolSettings = { ...DEFAULT_POOL_SETTINGS };
  readonly alerts = new Map<PoolAlertKind, Date>();
  sync: SyncStatus | null = null;
  readonly locks = new Map<string, { owner: string; until: Date }>();

  async getSettings() {
    return { ...this.settings };
  }

  async saveSettings(input: PoolSettingsInput, by: string, now: Date) {
    const before = { ...this.settings };
    const rateChanged = input.usdInrRate !== undefined && input.usdInrRate !== before.usdInrRate;
    this.settings = { ...this.settings, ...input, updatedBy: by, ...(rateChanged ? { usdInrRateUpdatedAt: now } : {}) };
    return { before, after: { ...this.settings } };
  }

  async lastAlert(kind: PoolAlertKind) {
    return this.alerts.get(kind) ?? null;
  }

  async markAlert(kind: PoolAlertKind, at: Date) {
    this.alerts.set(kind, at);
  }

  async lastSync() {
    return this.sync;
  }

  async saveSync(status: SyncStatus) {
    this.sync = status;
  }

  async acquireLock(name: string, owner: string, until: Date, now: Date) {
    const held = this.locks.get(name);
    if (held && held.until >= now) return false;
    this.locks.set(name, { owner, until });
    return true;
  }

  async releaseLock(name: string, owner: string) {
    if (this.locks.get(name)?.owner === owner) this.locks.delete(name);
  }
}

/** OpenAI's Costs API, answering from a list of cost lines. */
export class FakeOpenAiCosts implements OpenAiCosts {
  lines: { startTime: number; endTime: number; lineItem: string; projectId: string | null; amountUsd: number }[] = [];
  readonly calls: { startTime: number; endTime: number }[] = [];
  fail: Error | null = null;

  /** one line on a UTC day */
  add(date: string, amountUsd: number, lineItem = "gpt-5-mini, input", projectId: string | null = "proj_1"): void {
    const startTime = Date.parse(`${date}T00:00:00Z`) / 1000;
    this.lines.push({ startTime, endTime: startTime + 86_400, lineItem, projectId, amountUsd });
  }

  async costs(startTime: number, endTime: number) {
    this.calls.push({ startTime, endTime });
    if (this.fail) throw this.fail;
    return this.lines.filter((l) => l.startTime >= startTime && l.startTime < endTime);
  }
}

export class RecordingMailer implements Mailer {
  readonly delivers = true;
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage) {
    this.sent.push(message);
  }
}

/** The real AiCreditsModule over in-memory stores, a fake OpenAI and a recording mailer. */
export class TestAiCredits {
  private constructor(
    readonly port: AiCreditsPort,
    readonly gianAudit: InMemoryGianAudit,
    readonly wallets: InMemoryWallets,
    readonly catalogue: InMemoryCatalogue,
    readonly costs: InMemoryProviderCosts,
    readonly tracked: InMemoryTrackedCosts,
    readonly topUps: InMemoryTopUps,
    readonly state: InMemoryPoolState,
    readonly openai: FakeOpenAiCosts,
    readonly mailer: RecordingMailer,
  ) {}

  static create(options: { recipients?: string[]; openai?: boolean } = {}): TestAiCredits {
    const gianAudit = new InMemoryGianAudit();
    const wallets = new InMemoryWallets(gianAudit);
    const catalogue = new InMemoryCatalogue(gianAudit);
    const costs = new InMemoryProviderCosts();
    const tracked = new InMemoryTrackedCosts();
    const topUps = new InMemoryTopUps();
    const state = new InMemoryPoolState();
    const openai = new FakeOpenAiCosts();
    const mailer = new RecordingMailer();
    const module = new AiCreditsModule({
      logger: pino({ level: "silent" }),
      mailer,
      openai: { OPENAI_ADMIN_KEY: undefined },
      recipients: async () => options.recipients ?? ["boss@eazotel.com"],
      consoleUrl: "https://admin.example.test",
      schedule: false,
      overrides: {
        wallets,
        catalogue,
        gianAudit,
        costs,
        tracked,
        topUps,
        state,
        client: options.openai === false ? null : openai,
      },
    });
    return new TestAiCredits(module.port, gianAudit, wallets, catalogue, costs, tracked, topUps, state, openai, mailer);
  }
}
