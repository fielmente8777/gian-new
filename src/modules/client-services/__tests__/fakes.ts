import { pino } from "pino";

import type { MailMessage, Mailer } from "../../../integrations/mail/mailer.js";
import { InMemorySubscriptions } from "../../subscriptions/__tests__/fakes.js";
import { ServiceEnforcer } from "../services/service-enforcer.js";
import {
  CLIENT_SERVICES,
  type ClientServiceName,
  type ClientServiceStates,
  type ClientServicesPort,
  type PendingLeadAlert,
  type ServiceState,
} from "../types/client-services.types.js";

/** In-memory client_services, held leads, pending alerts and chatbots. */
export class InMemoryClientServices implements ClientServicesPort {
  readonly switches = new Map<string, Partial<Record<ClientServiceName, ServiceState>>>();
  /** held leads in ContactUs, per client */
  readonly held = new Map<string, number>();
  readonly alerts: (PendingLeadAlert & { claimId: string | null })[] = [];
  /** chatbots per client: their own `active` setting and whether staff paused them */
  readonly chatbots = new Map<string, { active: boolean; paused: boolean }>();
  readonly released: string[] = [];

  addAlert(ndid: string, name: string): void {
    this.alerts.push({
      id: String(this.alerts.length + 1).padStart(24, "0"),
      ndid,
      hid: null,
      name,
      phone: "+91 90000 00000",
      email: null,
      source: "website",
      message: null,
      receivedAt: new Date(),
      claimId: null,
    });
  }

  async get(ndid: string): Promise<ClientServiceStates> {
    const saved = this.switches.get(ndid) ?? {};
    return Object.fromEntries(
      CLIENT_SERVICES.map((s) => [s, saved[s] ?? { enabled: true, changedAt: null, changedBy: null }]),
    ) as ClientServiceStates;
  }

  async set(ndid: string, service: ClientServiceName, enabled: boolean, by: string) {
    this.switches.set(ndid, {
      ...this.switches.get(ndid),
      [service]: { enabled, changedAt: new Date(), changedBy: by },
    });
    return this.get(ndid);
  }

  async switchedOffNdids(service: ClientServiceName) {
    return [...this.switches].filter(([, s]) => s[service]?.enabled === false).map(([ndid]) => ndid);
  }

  async releaseHeldLeads(ndid: string) {
    const leads = this.held.get(ndid) ?? 0;
    this.held.delete(ndid);
    this.released.push(ndid);
    return { leads, contacts: 0 };
  }

  async countPendingAlerts(ndid: string) {
    return this.alerts.filter((a) => a.ndid === ndid).length;
  }

  async pendingAlertNdids() {
    return [...new Set(this.alerts.map((a) => a.ndid))];
  }

  async claimPendingAlerts(ndid: string, claimId: string) {
    for (const a of this.alerts) if (a.ndid === ndid && !a.claimId) a.claimId = claimId;
    return this.alerts.filter((a) => a.claimId === claimId);
  }

  async deletePendingAlerts(ids: string[]) {
    for (const id of ids) {
      const i = this.alerts.findIndex((a) => a.id === id);
      if (i >= 0) this.alerts.splice(i, 1);
    }
  }

  async unclaimPendingAlerts(claimId: string) {
    for (const a of this.alerts) if (a.claimId === claimId) a.claimId = null;
  }

  async pauseChatbot(ndid: string) {
    const bot = this.chatbots.get(ndid);
    if (!bot || bot.paused) return 0;
    bot.paused = true;
    return 1;
  }

  async restoreChatbot(ndid: string) {
    const bot = this.chatbots.get(ndid);
    if (!bot?.paused) return 0;
    bot.paused = false;
    return 1;
  }

  async pausedChatbotNdids() {
    return [...this.chatbots].filter(([, b]) => b.paused).map(([ndid]) => ndid);
  }
}

/** Catches the catch-up emails. */
export class FakeDigestMailbox implements Mailer {
  readonly sent: MailMessage[] = [];
  delivers = true;
  async send(message: MailMessage) {
    this.sent.push(message);
  }
}

/** The real ServiceEnforcer over in-memory stores, for tests. */
export class TestServiceControl {
  static create(subscriptions = new InMemorySubscriptions(), followExpiry = false) {
    const store = new InMemoryClientServices();
    const mailbox = new FakeDigestMailbox();
    const enforcer = new ServiceEnforcer(
      store,
      subscriptions,
      mailbox,
      async (ndid) => ({ to: [`${ndid}@hotel.test`], hotelName: `Hotel ${ndid}` }),
      pino({ level: "silent" }),
      followExpiry,
    );
    return { store, mailbox, subscriptions, enforcer, control: { store, enforcer } };
  }
}
