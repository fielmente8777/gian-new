import type { Mailer } from "../../integrations/mail/mailer.js";
import { OpenAiAdminClient } from "../../integrations/openai/openai-admin.client.js";
import type { OpenAiAdminConfig } from "../../integrations/openai/openai-admin.config.js";
import type { Logger } from "../../shared/logger/logger.js";
import type { AppModule } from "../../shared/module/app-module.js";
import { CreditCatalogueRepository } from "./repositories/credit-catalogue.repository.js";
import { GianAuditRepository, TrackedCostRepository } from "./repositories/gian-usage.repositories.js";
import {
  PoolStateRepository,
  ProviderCostRepository,
  TopUpRepository,
} from "./repositories/openai-pool.repositories.js";
import { WalletLedgerRepository } from "./repositories/wallet-ledger.repository.js";
import { AiPoolService } from "./services/ai-pool.service.js";
import { CostSyncScheduler } from "./services/cost-sync.scheduler.js";
import { CostSyncService } from "./services/cost-sync.service.js";
import { PoolAlertService } from "./services/pool-alert.service.js";
import type {
  AlertRecipients,
  CreditCatalogueStore,
  GianAuditStore,
  OpenAiCosts,
  PoolStateStore,
  ProviderCostStore,
  TopUpStore,
  TrackedCostStore,
  WalletStore,
} from "./types/ai-credits.types.js";

/** How long gian keeps active prices cached (getActivePricesCached in gian's pricing.ts). */
export const GIAN_PRICING_CACHE_SECONDS = 30;

/** What the admin module uses. Every part is a class or a store, so tests swap in fakes. */
export interface AiCreditsPort {
  wallets: WalletStore;
  catalogue: CreditCatalogueStore;
  gianAudit: GianAuditStore;
  topUps: TopUpStore;
  poolState: PoolStateStore;
  pool: AiPoolService;
  sync: CostSyncService;
  /** a price change reaches gian's AI requests within this many seconds */
  pricingCacheSeconds: number;
}

export interface AiCreditsModuleDeps {
  logger: Logger;
  mailer: Mailer;
  openai: OpenAiAdminConfig;
  /** active super admins' emails: who gets the low-pool alert */
  recipients: AlertRecipients;
  /** the admin console, for the link in the alert email */
  consoleUrl: string | null;
  /** false in tests and scripts: nothing runs on a timer */
  schedule: boolean;
  overrides?: {
    wallets?: WalletStore;
    catalogue?: CreditCatalogueStore;
    gianAudit?: GianAuditStore;
    costs?: ProviderCostStore;
    tracked?: TrackedCostStore;
    topUps?: TopUpStore;
    state?: PoolStateStore;
    /** null = OpenAI not configured */
    client?: OpenAiCosts | null;
  };
}

/**
 * AI credits for the admin console. Client wallets, the ledger, prices, packages and settings
 * live in gian's collections (gian charges every AI call); this module reads them and makes
 * staff changes with gian's own rules. It also owns the company OpenAI account view: costs
 * synced from OpenAI's Costs API, top-ups recorded by staff, the pool and its alerts.
 * No routes of its own: staff reach it through the admin module. See the README in this folder.
 */
export class AiCreditsModule implements AppModule {
  readonly name = "ai-credits";
  readonly port: AiCreditsPort;
  private readonly owned: { costs: ProviderCostStore; topUps: TopUpStore };
  private readonly scheduler: CostSyncScheduler | null;

  constructor(deps: AiCreditsModuleDeps) {
    const { overrides = {} } = deps;
    const wallets = overrides.wallets ?? new WalletLedgerRepository();
    const catalogue = overrides.catalogue ?? new CreditCatalogueRepository();
    const state = overrides.state ?? new PoolStateRepository();
    this.owned = {
      costs: overrides.costs ?? new ProviderCostRepository(),
      topUps: overrides.topUps ?? new TopUpRepository(),
    };
    const client =
      overrides.client !== undefined
        ? overrides.client
        : deps.openai.OPENAI_ADMIN_KEY
          ? new OpenAiAdminClient(deps.openai.OPENAI_ADMIN_KEY)
          : null;

    const pool = new AiPoolService(
      this.owned.costs,
      overrides.tracked ?? new TrackedCostRepository(),
      this.owned.topUps,
      wallets,
      catalogue,
      state,
      client !== null,
    );
    const alerts = new PoolAlertService(pool, state, deps.recipients, deps.mailer, deps.logger, deps.consoleUrl);
    const sync = new CostSyncService(client, this.owned.costs, state, alerts, deps.logger);

    if (!client) deps.logger.warn("OPENAI_ADMIN_KEY not set: the OpenAI pool and cost sync are off");
    this.scheduler = deps.schedule && client ? new CostSyncScheduler(sync, deps.logger) : null;

    this.port = {
      wallets,
      catalogue,
      gianAudit: overrides.gianAudit ?? new GianAuditRepository(),
      topUps: this.owned.topUps,
      poolState: state,
      pool,
      sync,
      pricingCacheSeconds: GIAN_PRICING_CACHE_SECONDS,
    };
  }

  async init(): Promise<void> {
    // only our own collections; gian builds the indexes of its collections
    const { costs, topUps } = this.owned;
    if (costs instanceof ProviderCostRepository) await costs.ensureIndexes();
    if (topUps instanceof TopUpRepository) await topUps.ensureIndexes();
    this.scheduler?.start();
  }

  async shutdown(): Promise<void> {
    this.scheduler?.stop();
  }
}
