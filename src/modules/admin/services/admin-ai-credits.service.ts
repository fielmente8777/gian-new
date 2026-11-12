import {
  InvalidThresholdsError,
  PackageNotFoundError,
  PricingNotFoundError,
  TopUpNotFoundError,
  type Actor,
  type AiCreditsPort,
  type CreditPackage,
  type CreditSettings,
  type GianAuditEntry,
  type LedgerPage,
  type PoolOverview,
  type PoolSettings,
  type PricingRow,
  type Reconciliation,
  type SyncStatus,
  type TopUp,
  type UsageSummary,
  type WalletView,
} from "../../ai-credits/index.js";
import type { ProfileRecord, ProfilesPort } from "../../profiles/index.js";
import type {
  AdjustCreditsBody,
  AiAuditQuery,
  AiClientListQuery,
  AiSettingsBody,
  BulkGrantBody,
  CreatePackageBody,
  CreatePricingBody,
  CreateTopUpBody,
  LedgerQuery,
  UpdatePackageBody,
  UpdatePricingBody,
  UpdateTopUpBody,
  WalletStatusBody,
} from "../dtos/admin-ai-credits.dto.js";
import { ClientNotFoundError } from "../errors/admin.errors.js";
import type { AdminRecord, AuditChanges } from "../types/admin.types.js";
import type { AdminAuditService } from "./admin-audit.service.js";
import { AdminPermissions } from "./admin-permissions.service.js";

const USAGE_DAYS = 30;
const DAY_MS = 86_400_000;

/** healthy ≥ low threshold > low ≥ critical threshold > critical > 0 = empty */
export type WalletLevel = "healthy" | "low" | "critical" | "empty";

export interface AiClientRow {
  ndid: string;
  hotelName: string | null;
  hotelEmail: string | null;
  wallet: WalletView;
  level: WalletLevel;
}

export interface AiClientDetail extends AiClientRow {
  usage: UsageSummary;
}

export interface PricingView extends PricingRow {
  /** what one credit costs us at the provider; null for non-USD rows */
  costPerCreditUsd: number | null;
  costPerCreditInr: number | null;
  /** margin at the cheapest active package's price per credit, in % */
  marginPct: number | null;
}

export interface BulkGrantResult {
  results: { ndid: string; ok: boolean; balanceAfter?: number; replayed?: boolean; error?: string }[];
  granted: number;
  failed: number;
}

/**
 * The admin console's AI credits screens. Wallets, prices, packages and settings are gian's
 * (the ai-credits module writes them with gian's rules and gian's audit rows); this class adds
 * the console's rules on top:
 *   - credits.view (every admin): wallets, ledger and usage of the admin's assigned clients only.
 *     A client outside them answers "not found", like everywhere else in the console.
 *   - credits.manage (advanced): add/remove credits, suspend/resume a wallet, bulk grants (scoped).
 *   - credits.pricing (advanced): company-wide things: the OpenAI pool, top-ups, costs,
 *     pricing, packages, settings and gian's AI credits audit log.
 * Every change is also written to admin_audit_logs, so the Activity screen shows it.
 */
export class AdminAiCreditsService {
  constructor(
    private readonly credits: AiCreditsPort,
    private readonly profiles: ProfilesPort,
    private readonly audit: AdminAuditService,
    private readonly trashed: () => Promise<string[]>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── company-wide (credits.pricing) ──────────────────────────────────────────────────────

  async overview(): Promise<
    PoolOverview & { lowWallets: AiClientRow[]; appliesWithinSeconds: number; chargingEnabled: boolean }
  > {
    const [overview, settings] = await Promise.all([
      this.credits.pool.overview(this.now()),
      this.credits.catalogue.getSettings(),
    ]);
    const low = await this.credits.wallets.lowest(10, settings.lowThreshold);
    const names = await this.names(low.map((w) => w.ndid));
    return {
      ...overview,
      lowWallets: low.map((w) => AdminAiCreditsService.row(w.ndid, names.get(w.ndid) ?? null, w, settings)),
      chargingEnabled: settings.enabled,
      appliesWithinSeconds: this.credits.pricingCacheSeconds,
    };
  }

  reconcile(days: number): Promise<Reconciliation> {
    return this.credits.pool.reconcile(days, this.now());
  }

  async syncNow(): Promise<SyncStatus> {
    return this.credits.sync.run(this.now());
  }

  async topUps(): Promise<{ items: TopUp[]; totalUsd: number }> {
    const items = await this.credits.topUps.list();
    return { items, totalUsd: Number(items.reduce((s, t) => s + t.amountUsd, 0).toFixed(4)) };
  }

  async addTopUp(admin: AdminRecord, body: CreateTopUpBody, ip?: string): Promise<TopUp> {
    const topUp = await this.credits.topUps.create(body, admin.email, this.now());
    await this.record(admin, "credits.openai_topup_added", null, null, { topUpId: topUp.id, ...body }, ip);
    return topUp;
  }

  async editTopUp(admin: AdminRecord, id: string, body: UpdateTopUpBody, ip?: string): Promise<TopUp> {
    const changed = await this.credits.topUps.update(id, body, admin.email, this.now());
    if (!changed) throw new TopUpNotFoundError();
    await this.record(
      admin,
      "credits.openai_topup_edited",
      null,
      AdminAiCreditsService.diff(changed.before, changed.after, Object.keys(body)),
      { topUpId: id },
      ip,
    );
    return changed.after;
  }

  async pricing(): Promise<{
    items: PricingView[];
    salePerCreditInr: { min: number; max: number } | null;
    appliesWithinSeconds: number;
  }> {
    const [rows, packages, pool] = await Promise.all([
      this.credits.catalogue.listPricing(),
      this.credits.catalogue.listPackages(),
      this.credits.poolState.getSettings(),
    ]);
    const perCredit = packages
      .filter((p) => p.status === "active" && p.currency === "INR" && p.credits > 0)
      .map((p) => p.price / p.credits);
    const sale = perCredit.length ? { min: Math.min(...perCredit), max: Math.max(...perCredit) } : null;
    return {
      items: rows.map((row) => AdminAiCreditsService.pricingView(row, pool, sale?.min ?? null)),
      salePerCreditInr: sale ? { min: Number(sale.min.toFixed(4)), max: Number(sale.max.toFixed(4)) } : null,
      appliesWithinSeconds: this.credits.pricingCacheSeconds,
    };
  }

  async createPricing(admin: AdminRecord, body: CreatePricingBody, ip?: string) {
    const row = await this.credits.catalogue.createPricing(body, AdminAiCreditsService.actor(admin, ip));
    await this.record(
      admin,
      "credits.pricing_changed",
      null,
      null,
      { created: `${row.provider}/${row.model}`, ...body },
      ip,
    );
    return { ...row, appliesWithinSeconds: this.credits.pricingCacheSeconds };
  }

  async updatePricing(admin: AdminRecord, id: string, body: UpdatePricingBody, ip?: string) {
    const changed = await this.credits.catalogue.updatePricing(id, body, AdminAiCreditsService.actor(admin, ip));
    if (!changed) throw new PricingNotFoundError();
    await this.record(
      admin,
      "credits.pricing_changed",
      null,
      AdminAiCreditsService.diff(changed.before, changed.after, Object.keys(body)),
      { pricing: `${changed.before.provider}/${changed.before.model}` },
      ip,
    );
    return { ...changed.after, appliesWithinSeconds: this.credits.pricingCacheSeconds };
  }

  packages(): Promise<CreditPackage[]> {
    return this.credits.catalogue.listPackages();
  }

  async createPackage(admin: AdminRecord, body: CreatePackageBody, ip?: string): Promise<CreditPackage> {
    const pack = await this.credits.catalogue.createPackage(body, AdminAiCreditsService.actor(admin, ip));
    await this.record(admin, "credits.package_changed", null, null, { created: pack.id, ...body }, ip);
    return pack;
  }

  async updatePackage(admin: AdminRecord, id: string, body: UpdatePackageBody, ip?: string): Promise<CreditPackage> {
    const changed = await this.credits.catalogue.updatePackage(id, body, AdminAiCreditsService.actor(admin, ip));
    if (!changed) throw new PackageNotFoundError();
    await this.record(
      admin,
      "credits.package_changed",
      null,
      AdminAiCreditsService.diff(changed.before, changed.after, Object.keys(body)),
      { packageId: id, name: changed.after.name },
      ip,
    );
    return changed.after;
  }

  async settings(): Promise<{ credits: CreditSettings; pool: PoolSettings; appliesWithinSeconds: number }> {
    const [credits, pool] = await Promise.all([
      this.credits.catalogue.getSettings(),
      this.credits.poolState.getSettings(),
    ]);
    return { credits, pool, appliesWithinSeconds: this.credits.pricingCacheSeconds };
  }

  async updateSettings(admin: AdminRecord, body: AiSettingsBody, ip?: string) {
    const changes: AuditChanges = {};
    if (body.credits && Object.keys(body.credits).length) {
      const current = await this.credits.catalogue.getSettings();
      const next = { ...current, ...body.credits };
      if (next.criticalThreshold >= next.lowThreshold) throw new InvalidThresholdsError();
      const changed = await this.credits.catalogue.updateSettings(body.credits, AdminAiCreditsService.actor(admin, ip));
      Object.assign(
        changes,
        AdminAiCreditsService.diff(changed.before, changed.after, Object.keys(body.credits), "credits."),
      );
    }
    if (body.pool && Object.keys(body.pool).length) {
      const changed = await this.credits.poolState.saveSettings(body.pool, admin.email, this.now());
      Object.assign(
        changes,
        AdminAiCreditsService.diff(changed.before, changed.after, Object.keys(body.pool), "pool."),
      );
    }
    if (Object.keys(changes).length) await this.record(admin, "credits.settings_changed", null, changes, null, ip);
    return this.settings();
  }

  gianAudit(query: AiAuditQuery): Promise<{ items: GianAuditEntry[]; nextCursor: string | null }> {
    return this.credits.gianAudit.list({
      limit: query.limit,
      ...(query.before ? { before: query.before } : {}),
      ...(query.ndid ? { tenantId: query.ndid } : {}),
    });
  }

  // ── per client (credits.view / credits.manage, scoped) ───────────────────────────────────

  async clients(
    admin: AdminRecord,
    query: AiClientListQuery,
  ): Promise<{ items: AiClientRow[]; nextCursor: string | null }> {
    const scope = AdminPermissions.propertyScope(admin);
    if (scope?.size === 0) return { items: [], nextCursor: null };
    const page = await this.profiles.list({
      limit: query.limit,
      ...(query.after ? { after: query.after } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(scope ? { ndids: [...scope.keys()] } : {}),
      excludeNdids: await this.trashed(),
    });
    const [wallets, settings] = await Promise.all([
      this.credits.wallets.findMany(page.items.map((p) => p.ndid)),
      this.credits.catalogue.getSettings(),
    ]);
    return {
      items: page.items.map((p) => AdminAiCreditsService.row(p.ndid, p, wallets.get(p.ndid)!, settings)),
      nextCursor: page.nextCursor,
    };
  }

  async client(admin: AdminRecord, ndid: string): Promise<AiClientDetail> {
    const profile = await this.visible(admin, ndid);
    const [wallet, settings, usage] = await Promise.all([
      this.credits.wallets.find(profile.ndid),
      this.credits.catalogue.getSettings(),
      this.credits.wallets.usage(profile.ndid, new Date(this.now().getTime() - USAGE_DAYS * DAY_MS)),
    ]);
    return { ...AdminAiCreditsService.row(profile.ndid, profile, wallet, settings), usage };
  }

  async ledger(admin: AdminRecord, ndid: string, query: LedgerQuery): Promise<LedgerPage> {
    const profile = await this.visible(admin, ndid);
    return this.credits.wallets.ledger(profile.ndid, {
      limit: query.limit,
      ...(query.before ? { before: query.before } : {}),
    });
  }

  async adjust(admin: AdminRecord, ndid: string, body: AdjustCreditsBody, ip?: string) {
    const profile = await this.visible(admin, ndid);
    const result = await this.credits.wallets.adjust(
      { ndid: profile.ndid, ...body },
      AdminAiCreditsService.actor(admin, ip),
    );
    if (!result.replayed) {
      await this.record(
        admin,
        body.direction === "add" ? "credits.granted" : "credits.deducted",
        profile,
        { balance: { from: result.balanceBefore, to: result.balanceAfter } },
        { amount: body.amount, reason: body.reason, transactionId: result.transactionId },
        ip,
      );
    }
    return result;
  }

  async setStatus(admin: AdminRecord, ndid: string, body: WalletStatusBody, ip?: string): Promise<WalletView> {
    const profile = await this.visible(admin, ndid);
    const { before } = await this.credits.wallets.setStatus(
      profile.ndid,
      body.status,
      body.reason,
      AdminAiCreditsService.actor(admin, ip),
    );
    if (before !== body.status) {
      await this.record(
        admin,
        body.status === "suspended" ? "credits.wallet_suspended" : "credits.wallet_resumed",
        profile,
        { status: { from: before, to: body.status } },
        { reason: body.reason },
        ip,
      );
    }
    return this.credits.wallets.find(profile.ndid);
  }

  /** Gives the same credits to several clients; each one is its own change and can fail alone. */
  async bulkGrant(admin: AdminRecord, body: BulkGrantBody, ip?: string): Promise<BulkGrantResult> {
    const scope = AdminPermissions.propertyScope(admin);
    const found = await this.profiles.list({ ndids: body.ndids, limit: body.ndids.length });
    const known = new Set(found.items.map((p) => p.ndid));
    const actor = AdminAiCreditsService.actor(admin, ip);
    const results: BulkGrantResult["results"] = [];
    for (const ndid of body.ndids) {
      if (!known.has(ndid) || (scope && !scope.has(ndid))) {
        results.push({ ndid, ok: false, error: "CLIENT_NOT_FOUND" });
        continue;
      }
      try {
        const r = await this.credits.wallets.adjust(
          {
            ndid,
            direction: "add",
            amount: body.amount,
            reason: body.reason,
            idempotencyKey: `${body.batchId}:${ndid}`,
          },
          actor,
        );
        results.push({ ndid, ok: true, balanceAfter: r.balanceAfter, replayed: r.replayed });
      } catch (err) {
        results.push({ ndid, ok: false, error: (err as { code?: string }).code ?? "FAILED" });
      }
    }
    const granted = results.filter((r) => r.ok && !r.replayed).length;
    const failed = results.filter((r) => !r.ok).length;
    if (granted > 0) {
      await this.record(
        admin,
        "credits.bulk_granted",
        null,
        null,
        {
          batchId: body.batchId,
          amount: body.amount,
          reason: body.reason,
          granted: results.filter((r) => r.ok && !r.replayed).map((r) => r.ndid),
          failed,
        },
        ip,
      );
    }
    return { results, granted, failed };
  }

  // ── helpers ─────────────────────────────────────────────────────────────────────────────

  /** The client, if this person may see it; otherwise the same "not found" as a missing one. */
  private async visible(admin: AdminRecord, ndid: string): Promise<ProfileRecord> {
    const profile = await this.profiles.findByNdid(ndid);
    const scope = AdminPermissions.propertyScope(admin);
    if (!profile || (scope && !scope.has(profile.ndid))) throw new ClientNotFoundError();
    return profile;
  }

  private async names(ndids: string[]): Promise<Map<string, ProfileRecord>> {
    if (ndids.length === 0) return new Map();
    const page = await this.profiles.list({ ndids, limit: ndids.length });
    return new Map(page.items.map((p) => [p.ndid, p]));
  }

  private record(
    admin: AdminRecord,
    action: Parameters<AdminAuditService["record"]>[0]["action"],
    client: ProfileRecord | null,
    changes: AuditChanges | null,
    details: Record<string, unknown> | null,
    ip?: string,
  ): Promise<void> {
    return this.audit.record({
      action,
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: client?.ndid ?? null,
      targetEmail: client?.hotelEmail ?? null,
      changes,
      details: client ? { hotelName: client.hotelName, ...details } : details,
      ip: ip ?? null,
    });
  }

  private static actor(admin: AdminRecord, ip?: string): Actor {
    return { email: admin.email, ip: ip ?? null };
  }

  static level(available: number, s: Pick<CreditSettings, "lowThreshold" | "criticalThreshold">): WalletLevel {
    if (available <= 0) return "empty";
    if (available < s.criticalThreshold) return "critical";
    if (available < s.lowThreshold) return "low";
    return "healthy";
  }

  private static row(ndid: string, profile: ProfileRecord | null, wallet: WalletView, s: CreditSettings): AiClientRow {
    return {
      ndid,
      hotelName: profile?.hotelName ?? null,
      hotelEmail: profile?.hotelEmail ?? null,
      wallet,
      level: AdminAiCreditsService.level(wallet.available, s),
    };
  }

  static pricingView(row: PricingRow, pool: PoolSettings, salePerCreditInr: number | null): PricingView {
    const costUsd = row.currency === "USD" && row.creditConversionRate > 0 ? 1 / row.creditConversionRate : null;
    const costInr = costUsd !== null && pool.usdInrRate ? costUsd * pool.usdInrRate : null;
    const marginPct =
      costInr !== null && salePerCreditInr ? ((salePerCreditInr - costInr) / salePerCreditInr) * 100 : null;
    return {
      ...row,
      costPerCreditUsd: costUsd === null ? null : Number(costUsd.toFixed(6)),
      costPerCreditInr: costInr === null ? null : Number(costInr.toFixed(6)),
      marginPct: marginPct === null ? null : Number(marginPct.toFixed(1)),
    };
  }

  /** Old and new value of each field the request named, when it really changed. */
  private static diff<T extends object>(before: T, after: T, keys: string[], prefix = ""): AuditChanges {
    const changes: AuditChanges = {};
    for (const key of keys) {
      const from = (before as Record<string, unknown>)[key];
      const to = (after as Record<string, unknown>)[key];
      if (JSON.stringify(from) !== JSON.stringify(to)) changes[`${prefix}${key}`] = { from, to };
    }
    return changes;
  }
}
