// Public API of the hotel-notifications module. Other modules import from here only.
export { HotelNotificationsModule } from "./hotel-notifications.module.js";
export {
  DEFAULT_ALERTS,
  LEAD_SOURCES,
  SourceAlertsDefaults,
  type HotelNotificationsPort,
  type LeadSource,
  type PropertyAlerts,
  type SourceAlerts,
  type SourceAlertsMap,
} from "./types/hotel-notifications.types.js";
