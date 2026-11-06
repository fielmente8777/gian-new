import type { Logger } from "../../../shared/logger/logger.js";
import type { PurchaseTerms, SubscriptionBillingPort } from "../../subscriptions/index.js";
import type { CatalogueStore, PurchaseKind } from "../types/billing.types.js";
import { BillingDates } from "./billing-dates.js";
import { EntitlementBuilder } from "./entitlement-builder.js";

export interface ActivationInput {
  ndid: string;
  terms: PurchaseTerms;
  kind: PurchaseKind | "auto_renew";
  /** value of the period before GST: what the next plan change credits back from */
  netPaise: number;
  paymentRef: string;
  orderId: string | null;
  paymentId: string | null;
  /** leftover credit as extra days (a change to something cheaper) */
  bonusDays?: number;
}

export interface Activation {
  periodStart: Date;
  periodEnd: Date;
  enabledApps: string[];
}

/** Runs after a period is applied: the client-services enforcer (releases held leads). */
export type AfterActivation = (ndid: string) => Promise<void>;

/**
 * Applies a paid period to the hotel's subscription. Used by the checkout (browser and
 * webhook) and by auto-renew charges, so a renewal works the same however it was paid.
 *
 * - renew / auto-renew: the new period starts where the current one ends (today if it has
 *   already ended), so paying early never loses a day;
 * - new / change: it starts now (a change was priced with a credit for the unused days).
 *
 * The plan's apps and the add-ons bought become exactly the apps the hotel has; every other
 * catalogue app is turned off. Staff stops are cleared and held leads are released.
 */
export class PeriodActivator {
  constructor(
    private readonly catalogue: CatalogueStore,
    private readonly subscriptions: SubscriptionBillingPort,
    private readonly after: AfterActivation,
    private readonly logger: Logger,
  ) {}

  async apply(input: ActivationInput, now: Date): Promise<Activation> {
    const [snapshot, plan, apps] = await Promise.all([
      this.subscriptions.snapshot(input.ndid),
      this.catalogue.plan(input.terms.planId),
      this.catalogue.apps(),
    ]);
    if (!plan) throw new Error(`plan ${input.terms.planId} no longer exists`);

    const extends_ = input.kind === "renew" || input.kind === "auto_renew";
    const running = snapshot && !snapshot.staffStop && snapshot.endDate > now;
    const periodStart = extends_ && running ? snapshot.endDate : now;
    const periodEnd = new Date(
      BillingDates.addMonths(periodStart, input.terms.cycleMonths).getTime() + (input.bonusDays ?? 0) * 86_400_000,
    );
    const entitlements = EntitlementBuilder.build({
      plan,
      catalogue: apps,
      addonCodes: input.terms.addonCodes,
      periodStart,
      periodEnd,
      existing: snapshot?.apps ?? [],
    });

    await this.subscriptions.activate(
      input.ndid,
      {
        planId: plan.id,
        // a renewal continues the subscription; anything else starts it again today
        startDate: extends_ && running ? snapshot.startDate : periodStart,
        endDate: periodEnd,
        apps: entitlements.apps,
        appAccess: entitlements.appAccess,
        billing: {
          ...input.terms,
          planCode: plan.code,
          periodStart,
          periodEnd,
          netPaise: input.netPaise,
          paymentRef: input.paymentRef,
          purchasedAt: now,
        },
        orderId: input.orderId,
        paymentId: input.paymentId,
      },
      now,
    );

    try {
      await this.after(input.ndid);
    } catch (error) {
      // the payment counts; held leads go out with the next one-minute sweep
      this.logger.error({ err: error, ndid: input.ndid }, "after-payment services update failed");
    }
    return { periodStart, periodEnd, enabledApps: entitlements.enabledCodes };
  }
}
