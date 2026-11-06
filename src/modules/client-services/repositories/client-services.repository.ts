import mongoose from "mongoose";

import { ObjectIds } from "../../../shared/database/object-id.js";
import {
  CLIENT_SERVICES,
  type ClientServiceName,
  type ClientServiceStates,
  type ClientServicesPort,
  type PendingLeadAlert,
  type ReleasedLeads,
  type ServiceState,
} from "../types/client-services.types.js";

interface ClientServicesDocument {
  ndid: string;
  services?: Partial<Record<ClientServiceName, Partial<ServiceState>>>;
  updatedAt?: Date;
}

interface PendingAlertDocument {
  ndid: string;
  hid?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  source?: string | null;
  message?: string | null;
  receivedAt?: Date;
  claimId?: string | null;
  claimedAt?: Date | null;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

/**
 * Raw collections, because gian owns the shapes of ContactUs, Contact, Eazbot and writes
 * pending_lead_alerts, and gian reads client_services directly:
 * - client_services: one document per client, the switches;
 * - pending_lead_alerts: one per lead the hotel was not told about;
 * - ContactUs / Contact: held leads keep their real ndid and have `heldAt` set;
 * - Eazbot: a paused chatbot has active false, servicePaused true and its own setting in
 *   activeBeforePause.
 */
export class ClientServicesRepository implements ClientServicesPort {
  private get switches() {
    return mongoose.connection.collection<ClientServicesDocument>("client_services");
  }

  private get alerts() {
    return mongoose.connection.collection<PendingAlertDocument>("pending_lead_alerts");
  }

  private get chatbots() {
    return mongoose.connection.collection("Eazbot");
  }

  async get(ndid: string): Promise<ClientServiceStates> {
    return ClientServicesRepository.states(await this.switches.findOne({ ndid }));
  }

  async set(ndid: string, service: ClientServiceName, enabled: boolean, by: string): Promise<ClientServiceStates> {
    const now = new Date();
    const doc = await this.switches.findOneAndUpdate(
      { ndid },
      {
        $set: { [`services.${service}`]: { enabled, changedAt: now, changedBy: by }, updatedAt: now },
        $setOnInsert: { ndid },
      },
      { upsert: true, returnDocument: "after" },
    );
    return ClientServicesRepository.states(doc);
  }

  async switchedOffNdids(service: ClientServiceName): Promise<string[]> {
    return (await this.switches.distinct("ndid", { [`services.${service}.enabled`]: false })) as string[];
  }

  async releaseHeldLeads(ndid: string): Promise<ReleasedLeads> {
    const release = { $unset: { heldAt: "" }, $set: { releasedAt: new Date() } };
    const held = { ndid, heldAt: { $exists: true } };
    const leads = await mongoose.connection.collection("ContactUs").updateMany(held, release);
    const contacts = await mongoose.connection.collection("Contact").updateMany(held, release);
    return { leads: leads.modifiedCount, contacts: contacts.modifiedCount };
  }

  countPendingAlerts(ndid: string): Promise<number> {
    return this.alerts.countDocuments({ ndid });
  }

  async pendingAlertNdids(): Promise<string[]> {
    return (await this.alerts.distinct("ndid")) as string[];
  }

  async claimPendingAlerts(ndid: string, claimId: string, staleBefore: Date): Promise<PendingLeadAlert[]> {
    await this.alerts.updateMany(
      { ndid, $or: [{ claimId: null }, { claimId: { $exists: false } }, { claimedAt: { $lt: staleBefore } }] },
      { $set: { claimId, claimedAt: new Date() } },
    );
    const docs = await this.alerts.find({ claimId }).sort({ receivedAt: 1 }).toArray();
    return docs.map((doc) => ({
      id: String(doc._id),
      ndid: doc.ndid,
      hid: text(doc.hid),
      name: text(doc.name),
      phone: text(doc.phone),
      email: text(doc.email),
      source: text(doc.source),
      message: text(doc.message),
      receivedAt: doc.receivedAt ?? new Date(0),
    }));
  }

  async deletePendingAlerts(ids: string[]): Promise<void> {
    const _ids = ids.map((id) => ObjectIds.parse(id)).filter((id) => id !== null);
    if (_ids.length) await this.alerts.deleteMany({ _id: { $in: _ids } });
  }

  async unclaimPendingAlerts(claimId: string): Promise<void> {
    await this.alerts.updateMany({ claimId }, { $set: { claimId: null, claimedAt: null } });
  }

  async pauseChatbot(ndid: string): Promise<number> {
    const result = await this.chatbots.updateMany({ ndid, servicePaused: { $ne: true } }, [
      { $set: { activeBeforePause: "$active", active: false, servicePaused: true } },
    ]);
    return result.modifiedCount;
  }

  async restoreChatbot(ndid: string): Promise<number> {
    const result = await this.chatbots.updateMany({ ndid, servicePaused: true }, [
      { $set: { active: { $ifNull: ["$activeBeforePause", true] } } },
      { $unset: ["activeBeforePause", "servicePaused"] },
    ]);
    return result.modifiedCount;
  }

  async pausedChatbotNdids(): Promise<string[]> {
    return (await this.chatbots.distinct("ndid", { servicePaused: true })) as string[];
  }

  /** client_services and pending_lead_alerts are new and small: building indexes on start is safe. */
  async ensureIndexes(): Promise<void> {
    await this.switches.createIndex({ ndid: 1 }, { unique: true });
    await this.alerts.createIndex({ ndid: 1, receivedAt: 1 });
    await this.alerts.createIndex({ claimId: 1 });
  }

  private static states(doc: ClientServicesDocument | null): ClientServiceStates {
    return Object.fromEntries(
      CLIENT_SERVICES.map((service) => {
        const saved = doc?.services?.[service];
        return [
          service,
          {
            enabled: saved?.enabled !== false,
            changedAt: saved?.changedAt ?? null,
            changedBy: saved?.changedBy ?? null,
          },
        ];
      }),
    ) as ClientServiceStates;
  }
}
