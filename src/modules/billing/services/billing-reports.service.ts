import type { SubscriptionBillingPort, SubscriptionBillingStats } from "../../subscriptions/index.js";
import type { PaymentPage, PaymentQuery, PaymentStore, RevenueSummary } from "../types/billing.types.js";

export interface BillingOverview {
  revenue: RevenueSummary;
  subscriptions: SubscriptionBillingStats;
}

/** The admin console's billing screens: who pays, how much, and what renews next. */
export class BillingReportsService {
  constructor(
    private readonly paymentStore: PaymentStore,
    private readonly subscriptions: SubscriptionBillingPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async overview(): Promise<BillingOverview> {
    const now = this.now();
    const [revenue, subscriptions] = await Promise.all([this.paymentStore.revenue(now), this.subscriptions.stats(now)]);
    return { revenue, subscriptions };
  }

  payments(query: PaymentQuery): Promise<PaymentPage> {
    return this.paymentStore.list(query);
  }
}
