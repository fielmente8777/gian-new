import { TRIAL_PLAN_CODE } from "../constants/billing.constants.js";
import {
  AppCodeTakenError,
  CatalogueAppNotFoundError,
  CataloguePlanNotFoundError,
  OfferCodeTakenError,
  OfferNotFoundError,
  PlanCodeTakenError,
  UnknownAppCodesError,
} from "../errors/billing.errors.js";
import type {
  AppInput,
  BillingSettings,
  CatalogueApp,
  CataloguePlan,
  CatalogueStore,
  NewOffer,
  Offer,
  OfferStore,
  PlanInput,
  SettingsInput,
} from "../types/billing.types.js";

/** An offer as the pricing page shows it: no counts, no private details. */
export interface PublicOffer {
  code: string;
  name: string;
  description: string;
  type: Offer["type"];
  value: number;
  maxDiscount: number | null;
  planCodes: string[];
  cycleMonths: number[];
  firstPurchaseOnly: boolean;
  endsAt: Date | null;
}

export interface PublicCatalogue {
  plans: CataloguePlan[];
  apps: CatalogueApp[];
  settings: Pick<BillingSettings, "currency" | "gstPercent" | "seatPrice" | "cycles" | "trialDays">;
  offers: PublicOffer[];
}

export interface AdminCatalogue {
  plans: CataloguePlan[];
  apps: CatalogueApp[];
  settings: BillingSettings;
  offers: Offer[];
}

export interface Changed<T> {
  before: T | null;
  after: T;
}

/**
 * What Eazotel sells and at what price. Hotels and the website read it; staff edit it from the
 * admin console. A price change applies to every purchase and renewal from then on; periods
 * already paid, and auto-renew mandates already set up, keep the amount they were made with.
 */
export class BillingCatalogueService {
  constructor(
    private readonly store: CatalogueStore,
    private readonly offers: OfferStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** For the website and every hotel: public plans, active apps, active cycles, featured offers. */
  async publicCatalogue(ndid?: string): Promise<PublicCatalogue> {
    const [plans, apps, settings, offers] = await Promise.all([
      this.store.plans(),
      this.store.apps(),
      this.store.settings(),
      this.offers.list(),
    ]);
    const now = this.now();
    return {
      plans: plans.filter((p) => BillingCatalogueService.visible(p, ndid)),
      apps: apps.filter((a) => a.isActive),
      settings: {
        currency: settings.currency,
        gstPercent: settings.gstPercent,
        seatPrice: settings.seatPrice,
        trialDays: settings.trialDays,
        cycles: settings.cycles.filter((c) => c.isActive),
      },
      offers: offers
        .filter(
          (o) =>
            o.isActive &&
            o.showOnPricing &&
            (o.ndids.length === 0 || (ndid !== undefined && o.ndids.includes(ndid))) &&
            (!o.startsAt || o.startsAt <= now) &&
            (!o.endsAt || o.endsAt > now) &&
            (o.maxRedemptions == null || o.redemptions < o.maxRedemptions),
        )
        .map((o) => ({
          code: o.code,
          name: o.name,
          description: o.description,
          type: o.type,
          value: o.value,
          maxDiscount: o.maxDiscount,
          planCodes: o.planCodes,
          cycleMonths: o.cycleMonths,
          firstPurchaseOnly: o.firstPurchaseOnly,
          endsAt: o.endsAt,
        })),
    };
  }

  /** Whether this hotel can buy the plan online (not the trial, has a price, not "contact sales" for it). */
  static purchasable(plan: CataloguePlan, ndid: string): boolean {
    if (!BillingCatalogueService.visible(plan, ndid) || plan.price <= 0) return false;
    return !plan.isCustom || plan.visibleTo.includes(ndid);
  }

  /** Shown to this hotel (or to everyone, without an ndid). */
  static visible(plan: CataloguePlan, ndid?: string): boolean {
    if (!plan.isActive || plan.code === TRIAL_PLAN_CODE) return false;
    return plan.isPublic || (ndid !== undefined && plan.visibleTo.includes(ndid));
  }

  plan(id: string): Promise<CataloguePlan | null> {
    return this.store.plan(id);
  }

  plans(): Promise<CataloguePlan[]> {
    return this.store.plans();
  }

  apps(): Promise<CatalogueApp[]> {
    return this.store.apps();
  }

  settings(): Promise<BillingSettings> {
    return this.store.settings();
  }

  // ─── admin console ──────────────────────────────────────────────────────────────────

  async adminCatalogue(): Promise<AdminCatalogue> {
    const [plans, apps, settings, offers] = await Promise.all([
      this.store.plans(),
      this.store.apps(),
      this.store.settings(),
      this.offers.list(),
    ]);
    return { plans, apps, settings, offers };
  }

  async createPlan(input: PlanInput, by: string): Promise<Changed<CataloguePlan>> {
    const plans = await this.store.plans();
    if (plans.some((p) => p.code === input.code)) throw new PlanCodeTakenError();
    await this.checkAppCodes(input.includedApps);
    return { before: null, after: await this.store.createPlan(input, by, this.now()) };
  }

  async updatePlan(id: string, changes: Partial<PlanInput>, by: string): Promise<Changed<CataloguePlan>> {
    const before = await this.store.plan(id);
    if (!before) throw new CataloguePlanNotFoundError();
    if (changes.code && changes.code !== before.code) {
      // hotels and gian find plans by id, but the website and old code match on planName
      if ((await this.store.plans()).some((p) => p.code === changes.code)) throw new PlanCodeTakenError();
    }
    if (changes.includedApps) await this.checkAppCodes(changes.includedApps);
    const after = await this.store.updatePlan(id, changes, by, this.now());
    if (!after) throw new CataloguePlanNotFoundError();
    return { before, after };
  }

  async createApp(input: AppInput): Promise<Changed<CatalogueApp>> {
    if ((await this.store.apps()).some((a) => a.code === input.code)) throw new AppCodeTakenError();
    return { before: null, after: await this.store.createApp(input, this.now()) };
  }

  async updateApp(id: string, changes: Partial<AppInput>): Promise<Changed<CatalogueApp>> {
    const apps = await this.store.apps();
    const before = apps.find((a) => a.id === id);
    if (!before) throw new CatalogueAppNotFoundError();
    // the code is what the dashboard unlocks by, so it never changes
    const { code: _ignored, ...rest } = changes;
    const after = await this.store.updateApp(id, rest, this.now());
    if (!after) throw new CatalogueAppNotFoundError();
    return { before, after };
  }

  async saveSettings(settings: SettingsInput, by: string): Promise<Changed<BillingSettings>> {
    const before = await this.store.settings();
    const merged = { ...settings, invoice: { ...before.invoice, ...(settings.invoice ?? {}) } };
    return { before, after: await this.store.saveSettings(merged, by, this.now()) };
  }

  async createOffer(input: NewOffer): Promise<Changed<Offer>> {
    if (await this.offers.byCode(input.code)) throw new OfferCodeTakenError();
    return { before: null, after: await this.offers.create(input, this.now()) };
  }

  async updateOffer(id: string, changes: Partial<NewOffer>): Promise<Changed<Offer>> {
    const before = await this.offers.byId(id);
    if (!before) throw new OfferNotFoundError();
    if (changes.code && changes.code !== before.code && (await this.offers.byCode(changes.code)))
      throw new OfferCodeTakenError();
    const after = await this.offers.update(id, changes, this.now());
    if (!after) throw new OfferNotFoundError();
    return { before, after };
  }

  private async checkAppCodes(codes: string[]): Promise<void> {
    const known = new Set((await this.store.apps()).map((a) => a.code));
    const unknown = codes.filter((c) => !known.has(c));
    if (unknown.length) throw new UnknownAppCodesError(unknown);
  }
}
