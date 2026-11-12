import { PhoneNumbers } from "../../../shared/utils/phone-numbers.js";
import {
  LEAD_SOURCES,
  SourceAlertsDefaults,
  type LeadSource,
  type HotelNotificationsPort,
  type PropertyAlerts,
  type SourceAlertsMap,
} from "../types/hotel-notifications.types.js";

/** In-memory hotelnotifications: saved settings per "ndid/hid". */
export class InMemoryHotelNotifications implements HotelNotificationsPort {
  readonly saved = new Map<string, SourceAlertsMap>();

  async list(ndid: string, hids: string[]): Promise<PropertyAlerts[]> {
    return hids.map((hid) => {
      const sources = this.saved.get(`${ndid}/${hid}`);
      return sources
        ? { hid, saved: true, sources: structuredClone(sources) }
        : { hid, saved: false, sources: SourceAlertsDefaults.all() };
    });
  }

  async save(ndid: string, hid: string, sources: SourceAlertsMap): Promise<PropertyAlerts> {
    this.saved.set(`${ndid}/${hid}`, structuredClone(sources));
    return { hid, saved: true, sources: structuredClone(sources) };
  }

  async addPhone(ndid: string, hid: string, phone: string): Promise<LeadSource[]> {
    const sources = this.saved.get(`${ndid}/${hid}`) ?? SourceAlertsDefaults.all();
    const added = LEAD_SOURCES.filter((s) => !sources[s].phones.some((p) => PhoneNumbers.same(p, phone)));
    for (const s of added) sources[s].phones.push(phone);
    this.saved.set(`${ndid}/${hid}`, sources);
    return added;
  }
}
