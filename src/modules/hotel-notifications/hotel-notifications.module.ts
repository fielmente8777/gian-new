import type { AppModule } from "../../shared/module/app-module.js";
import { HotelNotificationsRepository } from "./repositories/hotel-notifications.repository.js";
import type { HotelNotificationsPort } from "./types/hotel-notifications.types.js";

/**
 * A property's own lead alerts (email and WhatsApp, per lead source): the settings the hotel
 * edits in its dashboard and gian reads for every lead. See the README in this folder.
 */
export class HotelNotificationsModule implements AppModule {
  readonly name = "hotel-notifications";
  readonly port: HotelNotificationsPort;

  constructor(store?: HotelNotificationsPort) {
    this.port = store ?? new HotelNotificationsRepository();
  }
}
