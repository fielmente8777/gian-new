import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminClientsController } from "../controllers/admin-clients.controller.js";
import {
  BulkClientsDto,
  bulkResultSchema,
  trashListSchema,
  clientPageSchema,
  ClientListQueryDto,
  ClientParamsDto,
  clientSchema,
  DeleteClientDto,
  deletionPreviewSchema,
  deletionResultSchema,
  ClientServiceParamsDto,
  ClientPropertyParamsDto,
  clientNotificationsSchema,
  SaveNotificationsDto,
  clientServicesSchema,
  SetClientServiceDto,
  openedAccountSchema,
  UpdateClientDto,
} from "../dtos/admin-clients.dto.js";
import type { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";

/** /api/v1/admin/clients/*. Super admins see every client; admins only their assigned properties. */
export class AdminClientsRoutes extends BaseRoutes {
  constructor(c: AdminClientsController, auth: AdminAuthenticateMiddleware) {
    super("/admin/clients", { tag: "Admin clients" });

    this.get(
      "/",
      {
        summary: "Find clients",
        description: "Ordered by ndid. Page with `after`=`nextCursor`.",
        query: ClientListQueryDto,
        response: { schema: clientPageSchema },
      },
      auth.require("clients.view"),
      c.list,
    );
    this.post(
      "/bulk",
      {
        summary: "Pause, resume, move to the trash, restore or delete several clients",
        description:
          "Up to 50 at a time, one after the other, each with the same checks and audit entries as on its own " +
          "page. One failure doesn't stop the rest; every client gets a line in `results`. The trash is a " +
          "temporary delete: the client is hidden from every list and its subscription is paused (services stop, " +
          "no day is lost); restore resumes it. delete needs `confirm`: DELETE and the number of clients.",
        body: BulkClientsDto,
        response: { schema: bulkResultSchema },
        errors: { 400: "CONFIRMATION_MISMATCH", 403: "PERMISSION_DENIED" },
      },
      auth.require("clients.view"),
      c.bulk,
    );
    this.get(
      "/trash",
      {
        summary: "Clients in the trash",
        description: "Hidden from every list until restored. Newest first, within the person's properties.",
        response: { schema: trashListSchema },
      },
      auth.require("clients.trash"),
      c.trash,
    );
    this.get(
      "/:ndid",
      {
        summary: "One client, with its properties and account holder",
        params: ClientParamsDto,
        response: { schema: clientSchema },
        errors: { 404: "CLIENT_NOT_FOUND" },
      },
      auth.require("clients.view"),
      c.get,
    );
    this.patch(
      "/:ndid",
      {
        summary: "Edit a client's profile and properties",
        description:
          "Only the fields sent change. Empty text clears a field. The hotel name, domain, plan and the owner's " +
          "login email can't be changed here. Every change is written to the audit log.",
        params: ClientParamsDto,
        body: UpdateClientDto,
        response: { schema: clientSchema },
        errors: { 404: "CLIENT_NOT_FOUND, PROPERTY_NOT_FOUND" },
      },
      auth.require("clients.edit"),
      c.update,
    );
    this.post(
      "/:ndid/open-account",
      {
        summary: "Open the client's hotel dashboard as them",
        description:
          "Needs `clients.open_account`, and the client must be within the person's properties. Returns a 1-hour " +
          "nexon-style token for the account holder (no refresh), for the admin console to hand to the hotel " +
          "dashboard. Every opening is written to the audit log.",
        params: ClientParamsDto,
        response: { schema: openedAccountSchema },
        errors: {
          404: "CLIENT_NOT_FOUND, CLIENT_ACCOUNT_NOT_FOUND",
          409: "CLIENT_ACCOUNT_INACTIVE",
          503: "CLIENT_ACCOUNT_UNAVAILABLE",
        },
      },
      auth.require("clients.open_account"),
      c.openAccount,
    );
    this.get(
      "/:ndid/deletion-preview",
      {
        summary: "What deleting this client would remove",
        description: "Counts its records in every collection (by ndid / uId, and its users' login records).",
        params: ClientParamsDto,
        response: { schema: deletionPreviewSchema },
        errors: { 404: "CLIENT_NOT_FOUND" },
      },
      auth.require("clients.delete"),
      c.deletionPreview,
    );
    this.delete(
      "/:ndid",
      {
        summary: "Delete a client and all its records (super admins only)",
        description:
          "Every record of the client, in every collection, is copied to deleted_client_records and then deleted; " +
          "deleted_clients keeps one summary per deletion, so it can be restored by hand. `confirmName` must be the " +
          "hotel's name (or the ndid when it has none). Staff lose it from their assigned properties. Logged.",
        params: ClientParamsDto,
        body: DeleteClientDto,
        response: { schema: deletionResultSchema },
        errors: { 400: "CONFIRMATION_MISMATCH", 404: "CLIENT_NOT_FOUND" },
      },
      auth.require("clients.delete"),
      c.delete,
    );
    this.get(
      "/:ndid/services",
      {
        summary: "The client's services (chatbot, leads) and how many leads are held",
        params: ClientParamsDto,
        response: { schema: clientServicesSchema },
        errors: { 404: "CLIENT_NOT_FOUND" },
      },
      auth.require("subscriptions.view"),
      c.getServices,
    );
    this.put(
      "/:ndid/services/:service",
      {
        summary: "Switch a service on or off",
        description:
          "Off: gian-new and gian stop it within 30 seconds. The chatbot disappears from the website; new leads are " +
          "kept but not shown in the dashboard or sent by email or WhatsApp. Leads on: held leads move back to " +
          "the client. Switching leads on again releases any that arrived during the 30 seconds. Logged.",
        params: ClientServiceParamsDto,
        body: SetClientServiceDto,
        response: { schema: clientServicesSchema },
        errors: { 404: "CLIENT_NOT_FOUND" },
      },
      auth.require("subscriptions.manage"),
      c.setService,
    );
    this.get(
      "/:ndid/notifications",
      {
        summary: "Each property's lead alerts: email and WhatsApp, per lead source",
        description:
          "The settings the hotel edits in its dashboard (hotelnotifications), which gian reads for every lead. " +
          "`leadsDelivered` false means the Leads switch is off or the subscription is stopped: then nothing is " +
          "sent whatever these say.",
        params: ClientParamsDto,
        response: { schema: clientNotificationsSchema },
        errors: { 404: "CLIENT_NOT_FOUND" },
      },
      auth.require("clients.view"),
      c.getNotifications,
    );
    this.put(
      "/:ndid/notifications/:hid",
      {
        summary: "Save one property's lead alerts",
        description:
          "Send every source. Email alerts go to the hotel's email plus `emails`; WhatsApp alerts to the hotel's " +
          "phone plus `phones` (saved as digits with the country code). gian uses them from the next lead. Logged.",
        params: ClientPropertyParamsDto,
        body: SaveNotificationsDto,
        response: { schema: clientNotificationsSchema },
        errors: { 404: "CLIENT_NOT_FOUND, PROPERTY_NOT_FOUND" },
      },
      auth.require("clients.edit"),
      c.saveNotifications,
    );
  }
}
