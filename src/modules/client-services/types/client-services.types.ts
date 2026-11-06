/**
 * Services Eazotel staff can switch off for a client. gian-new's own endpoints and gian
 * (src/services/clientServices.service.ts) obey these: keep them in step. nexon is being
 * retired and never reads them.
 */
export const CLIENT_SERVICES = ["chatbot", "leads"] as const;
export type ClientServiceName = (typeof CLIENT_SERVICES)[number];

// While leads can't be delivered, gian saves new leads (ContactUs) and contacts (Contact)
// under the hotel's real ndid and hid with `heldAt` set. The hotel's lead list skips them;
// releasing removes `heldAt`.

export interface ServiceState {
  enabled: boolean;
  changedAt: Date | null;
  /** email of the staff member who last changed it */
  changedBy: string | null;
}

export type ClientServiceStates = Record<ClientServiceName, ServiceState>;

export interface ReleasedLeads {
  leads: number;
  contacts: number;
}

/** A lead the hotel was not told about, kept for the catch-up email (pending_lead_alerts). */
export interface PendingLeadAlert {
  id: string;
  ndid: string;
  hid: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  message: string | null;
  receivedAt: Date;
}

/** The switches, the held leads and the chatbot's paused flag, in the shared database. */
export interface ClientServicesPort {
  /** Every service of the client; one without a saved switch is on. */
  get(ndid: string): Promise<ClientServiceStates>;
  set(ndid: string, service: ClientServiceName, enabled: boolean, by: string): Promise<ClientServiceStates>;
  /** clients with a service switched off */
  switchedOffNdids(service: ClientServiceName): Promise<string[]>;

  /** Moves held leads and contacts back to the client, so they show in the dashboard. */
  releaseHeldLeads(ndid: string): Promise<ReleasedLeads>;
  countPendingAlerts(ndid: string): Promise<number>;
  pendingAlertNdids(): Promise<string[]>;
  /** Marks this client's unclaimed (or long-stuck) alerts as `claimId`'s, and returns them. */
  claimPendingAlerts(ndid: string, claimId: string, staleBefore: Date): Promise<PendingLeadAlert[]>;
  deletePendingAlerts(ids: string[]): Promise<void>;
  unclaimPendingAlerts(claimId: string): Promise<void>;

  /** Hides every chatbot of the client on its website, remembering each one's own setting. */
  pauseChatbot(ndid: string): Promise<number>;
  /** Gives each chatbot its own setting back. */
  restoreChatbot(ndid: string): Promise<number>;
  pausedChatbotNdids(): Promise<string[]>;
}
