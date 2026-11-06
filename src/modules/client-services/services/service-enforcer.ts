import { randomUUID } from "node:crypto";

import type { Mailer } from "../../../integrations/mail/mailer.js";
import type { Logger } from "../../../shared/logger/logger.js";
import { SubscriptionRule, type SubscriptionsPort } from "../../subscriptions/index.js";
import type {
  ClientServiceStates,
  ClientServicesPort,
  PendingLeadAlert,
  ReleasedLeads,
} from "../types/client-services.types.js";
import { LeadDigest } from "./lead-digest.js";

/** What actually runs for a client: its switch, and whether its subscription is serving. */
export interface EffectiveServices {
  switches: ClientServiceStates;
  /** false while staff have stopped the subscription, or (with followExpiry) it has ended */
  subscriptionServing: boolean;
  chatbot: boolean;
  leads: boolean;
}

export interface ApplyResult extends EffectiveServices {
  released: ReleasedLeads | null;
  /** leads in the catch-up email just sent */
  emailed: number;
}

/** Where the catch-up email goes for a client. */
export type DigestRecipients = (ndid: string) => Promise<{ to: string[]; hotelName: string | null }>;

/** A claim older than this was left by a crashed run and may be taken again. */
const STALE_CLAIM_MS = 10 * 60_000;

/**
 * Makes the shared database match what a client should get. Called right after every staff
 * change, and every CLIENT_SERVICES_SWEEP_SECONDS for changes made elsewhere (a hotel paying
 * in gian, a subscription running out):
 *
 * - chatbot: paused in Eazbot (hidden on the website) or given its own setting back;
 * - leads: when they can be delivered again, held leads move back into the dashboard and ONE
 *   catch-up email lists what came in meanwhile.
 *
 * Safe to run from several instances at once: releases are idempotent, and alerts are
 * claimed before the email, so each lead is emailed once.
 */
export class ServiceEnforcer {
  constructor(
    private readonly services: ClientServicesPort,
    private readonly subscriptions: Pick<SubscriptionsPort, "findByNdid" | "stoppedNdids">,
    private readonly mailer: Mailer,
    private readonly recipients: DigestRecipients,
    private readonly logger: Logger,
    private readonly followExpiry: boolean,
  ) {}

  async effective(ndid: string): Promise<EffectiveServices> {
    const [switches, subscription] = await Promise.all([this.services.get(ndid), this.subscriptions.findByNdid(ndid)]);
    const subscriptionServing = SubscriptionRule.serving(subscription, this.followExpiry);
    return {
      switches,
      subscriptionServing,
      chatbot: switches.chatbot.enabled && subscriptionServing,
      leads: switches.leads.enabled && subscriptionServing,
    };
  }

  async apply(ndid: string): Promise<ApplyResult> {
    const effective = await this.effective(ndid);
    if (effective.chatbot) await this.services.restoreChatbot(ndid);
    else await this.services.pauseChatbot(ndid);

    let released: ReleasedLeads | null = null;
    let emailed = 0;
    if (effective.leads) {
      released = await this.services.releaseHeldLeads(ndid);
      emailed = await this.sendCatchUp(ndid);
    }
    return { ...effective, released, emailed };
  }

  /** Every client that may need a change. One failing client never stops the others. */
  async sweep(): Promise<void> {
    const ndids = new Set([
      ...(await this.services.pendingAlertNdids()),
      ...(await this.services.pausedChatbotNdids()),
      ...(await this.services.switchedOffNdids("chatbot")),
      ...(await this.subscriptions.stoppedNdids(this.followExpiry, new Date())),
    ]);
    for (const ndid of ndids) {
      try {
        await this.apply(ndid);
      } catch (err) {
        this.logger.error({ err, ndid }, "client services: could not apply");
      }
    }
  }

  /** The leads the hotel wasn't told about, in one email. Kept for later if mail can't be sent here. */
  private async sendCatchUp(ndid: string): Promise<number> {
    if (!this.mailer.delivers) return 0;
    const claimId = randomUUID();
    const alerts = await this.services.claimPendingAlerts(ndid, claimId, new Date(Date.now() - STALE_CLAIM_MS));
    if (alerts.length === 0) return 0;

    try {
      const { to, hotelName } = await this.recipients(ndid);
      if (to.length === 0) {
        this.logger.warn({ ndid, leads: alerts.length }, "client services: no email address for the catch-up email");
        await this.services.unclaimPendingAlerts(claimId);
        return 0;
      }
      await this.mailer.send({ to: to.join(","), ...LeadDigest.render(hotelName, alerts) });
      await this.services.deletePendingAlerts(alerts.map((a: PendingLeadAlert) => a.id));
      this.logger.info({ ndid, leads: alerts.length }, "client services: catch-up email sent");
      return alerts.length;
    } catch (err) {
      await this.services.unclaimPendingAlerts(claimId);
      throw err;
    }
  }
}
