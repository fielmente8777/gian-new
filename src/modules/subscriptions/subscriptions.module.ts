import type { AppModule } from "../../shared/module/app-module.js";
import { SubscriptionBillingRepository } from "./repositories/subscription-billing.repository.js";
import { SubscriptionRepository } from "./repositories/subscription.repository.js";
import type { SubscriptionBillingPort, SubscriptionsPort } from "./types/subscriptions.types.js";

/**
 * Hotel subscriptions (gian's `subscriptions` and `plans` collections): the data layer the
 * admin console (`port`) and billing (`billing`) work through.
 */
export class SubscriptionsModule implements AppModule {
  readonly name = "subscriptions";
  readonly port: SubscriptionsPort = new SubscriptionRepository();
  readonly billing: SubscriptionBillingPort = new SubscriptionBillingRepository();
}
