// Types of the ai-credits module. The "Store" interfaces are ports: the repositories implement
// them over MongoDB and the tests replace them with in-memory fakes.

/** Who did something from the admin console. gian's audit rows name the actor by email. */
export interface Actor {
  email: string;
  ip: string | null;
}

// ── wallets and the ledger (gian's aiwallets / aicredittransactions / aiusagelogs) ─────────

export type WalletStatus = "active" | "suspended";

/** One client's AI wallet. A client without a wallet yet reads as an empty, active one. */
export interface WalletView {
  ndid: string;
  /** false until gian or staff create the wallet */
  exists: boolean;
  balance: number;
  /** part of the balance held by AI requests running right now */
  reservedCredits: number;
  /** balance - reserved: what the next request can use */
  available: number;
  totalPurchased: number;
  totalUsed: number;
  totalAdjustedIn: number;
  totalAdjustedOut: number;
  status: WalletStatus;
  lastRechargeAt: Date | null;
}

export type LedgerType = "purchase" | "usage" | "adjustment";

/** One real balance change, as gian writes it. */
export interface LedgerEntry {
  id: string;
  type: LedgerType;
  /** signed: + added credits, - removed them */
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  service: string | null;
  description: string;
  referenceId: string;
  performedBy: string | null;
  createdAt: Date;
}

export interface LedgerPage {
  items: LedgerEntry[];
  /** pass as `before` for older entries; null when there are none */
  nextCursor: string | null;
}

export interface UsageRow {
  key: string;
  credits: number;
  tokens: number;
  costUsd: number;
  operations: number;
}

/** What a client's AI used since `from`, from gian's aiusagelogs. */
export interface UsageSummary {
  from: Date;
  credits: number;
  /** owed but not taken because the balance ran out mid-request */
  uncollectedCredits: number;
  tokens: number;
  costUsd: number;
  operations: number;
  byService: UsageRow[];
  byModel: UsageRow[];
}

export interface Adjustment {
  ndid: string;
  direction: "add" | "deduct";
  /** whole credits, > 0 */
  amount: number;
  reason: string;
  /** the same key twice applies the change once */
  idempotencyKey: string;
}

export interface AdjustmentResult {
  transactionId: string;
  balanceBefore: number;
  balanceAfter: number;
  /** true when this key was already applied: nothing changed this time */
  replayed: boolean;
}

export interface WalletTotals {
  wallets: number;
  suspended: number;
  balance: number;
  reserved: number;
  available: number;
  totalPurchased: number;
  totalUsed: number;
}

export interface WalletStore {
  find(ndid: string): Promise<WalletView>;
  findMany(ndids: string[]): Promise<Map<string, WalletView>>;
  totals(): Promise<WalletTotals>;
  /** wallets with the least available credits first, only those below `below` */
  lowest(limit: number, below: number): Promise<WalletView[]>;
  ledger(ndid: string, page: { limit: number; before?: string }): Promise<LedgerPage>;
  usage(ndid: string, from: Date): Promise<UsageSummary>;
  /**
   * Adds or removes credits in one transaction: wallet, ledger row and gian's audit row.
   * A deduction never takes more than the available credits (InsufficientCreditsError).
   */
  adjust(adjustment: Adjustment, actor: Actor): Promise<AdjustmentResult>;
  setStatus(ndid: string, status: WalletStatus, reason: string, actor: Actor): Promise<{ before: WalletStatus }>;
}

// ── pricing, packages and settings (gian's aipricings / aicreditpackages / aicreditsettings) ──

export type RowStatus = "active" | "inactive";

/** Provider prices per 1M tokens in `currency`; creditConversionRate = credits per 1 unit of cost. */
export interface PricingRow {
  id: string;
  provider: string;
  model: string;
  inputPrice: number;
  outputPrice: number;
  embeddingPrice: number;
  requestPrice: number;
  currency: string;
  creditConversionRate: number;
  status: RowStatus;
  updatedAt: Date | null;
  updatedBy: string | null;
}
export type PricingInput = Omit<PricingRow, "id" | "updatedAt" | "updatedBy">;

/** A recharge pack the hotel dashboard sells. Price in major units of `currency` (₹). */
export interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  status: RowStatus;
  popular: boolean;
  sortOrder: number;
  updatedAt: Date | null;
}
export type PackageInput = Omit<CreditPackage, "id" | "updatedAt">;

/** gian's single aicreditsettings document (key "global"). */
export interface CreditSettings {
  /** Charging on/off. Off: gian runs AI for every hotel with no holds, charges or 402s. */
  enabled: boolean;
  lowThreshold: number;
  criticalThreshold: number;
  chatReserveCredits: number;
  reserveMultiplier: number;
  reservationTtlMinutes: number;
  fallbackCreditsPer1kTokens: number;
  fallbackCreditsPerRequest: number;
}

export interface Changed<T> {
  before: T;
  after: T;
}

export interface CreditCatalogueStore {
  listPricing(): Promise<PricingRow[]>;
  /** DuplicatePricingError when the provider + model already has a row */
  createPricing(input: PricingInput, actor: Actor): Promise<PricingRow>;
  updatePricing(id: string, changes: Partial<PricingInput>, actor: Actor): Promise<Changed<PricingRow> | null>;
  listPackages(): Promise<CreditPackage[]>;
  createPackage(input: PackageInput, actor: Actor): Promise<CreditPackage>;
  updatePackage(id: string, changes: Partial<PackageInput>, actor: Actor): Promise<Changed<CreditPackage> | null>;
  getSettings(): Promise<CreditSettings>;
  updateSettings(changes: Partial<CreditSettings>, actor: Actor): Promise<Changed<CreditSettings>>;
}

/** One row of gian's aiadminauditlogs (written by gian's dashboard admin page and by us). */
export interface GianAuditEntry {
  id: string;
  actor: string;
  action: string;
  tenantId: string | null;
  target: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  createdAt: Date;
}

export interface GianAuditStore {
  list(query: { limit: number; before?: string; tenantId?: string }): Promise<{
    items: GianAuditEntry[];
    nextCursor: string | null;
  }>;
}

// ── the OpenAI account (gian-new's own collections) ────────────────────────────────────────

/** One day's OpenAI cost for one line item and project, from the Costs API. Dates are UTC. */
export interface DailyCost {
  /** YYYY-MM-DD (UTC) */
  date: string;
  lineItem: string;
  projectId: string | null;
  amountUsd: number;
}

export interface ProviderCostStore {
  /** the newest day saved, or null before the first sync */
  latestDate(): Promise<string | null>;
  /** Replaces everything saved for these days with `rows` (OpenAI revises recent days). */
  replaceDays(days: string[], rows: DailyCost[], fetchedAt: Date): Promise<void>;
  /** total per day, both ends included */
  dailyTotals(from: string, to: string): Promise<{ date: string; amountUsd: number }[]>;
  lineItems(from: string, to: string): Promise<{ lineItem: string; amountUsd: number }[]>;
  sumSince(from: string): Promise<number>;
}

/** What gian itself recorded for OpenAI calls, per UTC day, to compare with OpenAI's bill. */
export interface TrackedCostDay {
  date: string;
  /** every OpenAI call gian made (aiprovidercalls), billed to a client or not */
  trackedUsd: number;
  /** the part billed to a client wallet (aiusagelogs) */
  billedUsd: number;
  calls: number;
}

export interface TrackedCostStore {
  daily(from: Date, to: Date): Promise<TrackedCostDay[]>;
}

/** Money put into the OpenAI account, recorded by hand (OpenAI has no balance API). */
export interface TopUp {
  id: string;
  amountUsd: number;
  /** YYYY-MM-DD the money reached OpenAI */
  paidOn: string;
  note: string | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string | null;
  updatedAt: Date | null;
}
export type TopUpInput = Pick<TopUp, "amountUsd" | "paidOn" | "note">;

export interface TopUpStore {
  list(): Promise<TopUp[]>;
  create(input: TopUpInput, by: string, now: Date): Promise<TopUp>;
  update(id: string, changes: Partial<TopUpInput>, by: string, now: Date): Promise<Changed<TopUp> | null>;
}

/** Pool alerts and display settings, set from the console. */
export interface PoolSettings {
  /** alert when the OpenAI pool falls below this many USD */
  lowPoolUsd: number;
  /** alert when the pool lasts fewer days than this at the last 7 days' spend */
  lowRunwayDays: number;
  /** besides every active super admin */
  alertEmails: string[];
  /** for showing ₹ next to USD; null = not set, nothing converted */
  usdInrRate: number | null;
  usdInrRateUpdatedAt: Date | null;
  updatedBy: string | null;
}
export type PoolSettingsInput = Partial<
  Pick<PoolSettings, "lowPoolUsd" | "lowRunwayDays" | "alertEmails" | "usdInrRate">
>;

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  lowPoolUsd: 25,
  lowRunwayDays: 5,
  alertEmails: [],
  usdInrRate: null,
  usdInrRateUpdatedAt: null,
  updatedBy: null,
};

export type PoolAlertKind = "low_pool" | "low_runway";

export interface SyncStatus {
  at: Date;
  ok: boolean;
  /** days fetched, oldest first */
  from: string | null;
  to: string | null;
  rows: number;
  error: string | null;
}

export interface PoolStateStore {
  getSettings(): Promise<PoolSettings>;
  saveSettings(input: PoolSettingsInput, by: string, now: Date): Promise<Changed<PoolSettings>>;
  lastAlert(kind: PoolAlertKind): Promise<Date | null>;
  markAlert(kind: PoolAlertKind, at: Date): Promise<void>;
  lastSync(): Promise<SyncStatus | null>;
  saveSync(status: SyncStatus): Promise<void>;
  /** True when this caller now holds the lock until `until`. A held, unexpired lock answers false. */
  acquireLock(name: string, owner: string, until: Date, now: Date): Promise<boolean>;
  releaseLock(name: string, owner: string): Promise<void>;
}

/** Reads OpenAI's organization costs (integrations/openai). */
export interface OpenAiCosts {
  costs(
    startTime: number,
    endTime: number,
  ): Promise<{ startTime: number; endTime: number; lineItem: string; projectId: string | null; amountUsd: number }[]>;
}

/** Active super admins' emails, from the admin module (the alert recipients). */
export type AlertRecipients = () => Promise<string[]>;
