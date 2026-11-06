import {
  SourceAlertsDefaults,
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
}
