import mongoose, { Types } from "mongoose";

import {
  LEAD_SOURCES,
  SourceAlertsDefaults,
  type HotelNotificationsPort,
  type LeadSource,
  type PropertyAlerts,
  type SourceAlertsMap,
} from "../types/hotel-notifications.types.js";

/** gian's shape for one source (EmailConfig.model.ts): a subdocument with its own _id. */
interface SourceConfigDocument {
  _id?: Types.ObjectId;
  email?: string[];
  isEmailAllowed?: boolean;
  phone?: string[];
  isPhoneAllowed?: boolean;
}

interface HotelNotificationDocument {
  _id?: Types.ObjectId;
  ndid: string;
  hid: string;
  config?: Partial<Record<LeadSource, SourceConfigDocument>>;
  callConfig?: unknown;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];

/**
 * hotelnotifications, the raw collection: gian owns its schema and reads it for every lead,
 * and the hotel dashboard edits it through gian. One document per (ndid, hid).
 */
export class HotelNotificationsRepository implements HotelNotificationsPort {
  private get collection() {
    return mongoose.connection.collection<HotelNotificationDocument>("hotelnotifications");
  }

  async list(ndid: string, hids: string[]): Promise<PropertyAlerts[]> {
    if (hids.length === 0) return [];
    const docs = await this.collection
      .find({ ndid, hid: { $in: hids } })
      .sort({ _id: 1 })
      .toArray();
    // gian reads with findOne({ ndid, hid }): the first document wins if there are two
    const byHid = new Map<string, HotelNotificationDocument>();
    for (const doc of docs) if (!byHid.has(doc.hid)) byHid.set(doc.hid, doc);
    return hids.map((hid) => HotelNotificationsRepository.toAlerts(hid, byHid.get(hid) ?? null));
  }

  async save(ndid: string, hid: string, sources: SourceAlertsMap): Promise<PropertyAlerts> {
    const before = await this.collection.findOne({ ndid, hid }, { sort: { _id: 1 } });
    const $set: Record<string, SourceConfigDocument> = {};
    for (const source of LEAD_SOURCES) {
      const s = sources[source];
      $set[`config.${source}`] = {
        _id: before?.config?.[source]?._id ?? new Types.ObjectId(),
        phone: s.phones,
        isPhoneAllowed: s.whatsapp,
        email: s.emails,
        isEmailAllowed: s.email,
      };
    }
    const doc = await this.collection.findOneAndUpdate(
      before?._id ? { _id: before._id } : { ndid, hid },
      { $set, $setOnInsert: { ndid, hid } },
      { upsert: true, returnDocument: "after" },
    );
    return HotelNotificationsRepository.toAlerts(hid, doc);
  }

  private static toAlerts(hid: string, doc: HotelNotificationDocument | null): PropertyAlerts {
    const sources = SourceAlertsDefaults.all();
    for (const source of LEAD_SOURCES) {
      const c = doc?.config?.[source];
      if (!c) continue;
      sources[source] = {
        // gian emails only when isEmailAllowed is true, and skips WhatsApp only when it is saved false
        email: c.isEmailAllowed === true,
        emails: strings(c.email),
        whatsapp: c.isPhoneAllowed !== false,
        phones: strings(c.phone),
      };
    }
    return { hid, saved: Boolean(doc), sources };
  }
}
