import { CORE_FEATURE_KEYS } from "../constants/billing.constants.js";
import type { CatalogueApp, CataloguePlan } from "../types/billing.types.js";

export interface EntitlementInput {
  plan: CataloguePlan;
  catalogue: CatalogueApp[];
  addonCodes: string[];
  periodStart: Date;
  periodEnd: Date;
  /** the subscription's apps now, so an app the hotel already had keeps its first start date */
  existing: { appId: string; startDate: Date }[];
}

export interface Entitlements {
  /** the subscription's `apps`: one entry per app the hotel now has */
  apps: { appId: string; startDate: Date; endDate: Date }[];
  /** `appAccess` keys to set: every catalogue app on or off, every core feature on */
  appAccess: Record<string, boolean>;
  /** codes of the apps that are on */
  enabledCodes: string[];
}

/**
 * Turns a purchase into what the hotel dashboard unlocks. The dashboard reads `appAccess`, so
 * after a payment exactly the plan's apps and the add-ons bought are on, and every other app
 * in the catalogue is off. Trial "everything on" ends with the first payment.
 */
export class EntitlementBuilder {
  static build({ plan, catalogue, addonCodes, periodStart, periodEnd, existing }: EntitlementInput): Entitlements {
    const enabled = new Set([...plan.includedApps, ...addonCodes]);
    const firstStart = new Map<string, Date>();
    for (const entry of existing) {
      const seen = firstStart.get(entry.appId);
      if (!seen || entry.startDate < seen) firstStart.set(entry.appId, entry.startDate);
    }
    const on = catalogue.filter((a) => enabled.has(a.code));
    return {
      apps: on.map((a) => ({
        appId: a.id,
        startDate: firstStart.get(a.id) ?? periodStart,
        endDate: periodEnd,
      })),
      appAccess: {
        ...Object.fromEntries(catalogue.filter((a) => a.code).map((a) => [a.code, enabled.has(a.code)])),
        ...Object.fromEntries(CORE_FEATURE_KEYS.map((key) => [key, true])),
      },
      enabledCodes: on.map((a) => a.code),
    };
  }
}
