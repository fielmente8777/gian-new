import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminTeamPhonesController } from "../controllers/admin-team-phones.controller.js";
import { ClientParamsDto } from "../dtos/admin-clients.dto.js";
import {
  clientTeamSchema,
  FixOwnerPhonesDto,
  fixOwnerPhonesSchema,
  ownersMissingPhoneSchema,
  SetTeamPhoneDto,
  TeamMemberParamsDto,
} from "../dtos/admin-team-phones.dto.js";
import type { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";

/**
 * /api/v1/admin/team-phones/*: the WhatsApp numbers of each client's dashboard users
 * (Zucks_users.phone). The hotel dashboard's team list and its lead-alert picker only offer
 * people with a number, and nexon's Google sign-up stores none for the account holder.
 */
export class AdminTeamPhonesRoutes extends BaseRoutes {
  constructor(c: AdminTeamPhonesController, auth: AdminAuthenticateMiddleware) {
    super("/admin/team-phones", { tag: "Admin clients" });

    this.get(
      "/missing-owners",
      {
        summary: "Account holders with no phone",
        description:
          "The oldest admin of each client, when it has no phone, within the person's properties and outside the " +
          "trash (at most 500). `suggestedPhone` is the hotel phone Fix would copy, null when it has no country code.",
        response: { schema: ownersMissingPhoneSchema },
      },
      auth.require("clients.view"),
      c.missingOwners,
    );
    this.post(
      "/fix-owners",
      {
        summary: "Copy the hotel phone to account holders that have none",
        description:
          "For each client: only when the account holder's phone is still empty (checked inside the write, so a " +
          "number saved meanwhile is kept) and the hotel phone has a country code. The number is also added to " +
          "every lead source's WhatsApp list of each property, without changing any switch. Logged per client.",
        body: FixOwnerPhonesDto,
        response: { schema: fixOwnerPhonesSchema },
      },
      auth.require("clients.edit"),
      c.fixOwners,
    );
    this.get(
      "/:ndid",
      {
        summary: "A client's team and their WhatsApp numbers",
        description: "Every dashboard user of the client, owner first, and whether each number gets lead alerts.",
        params: ClientParamsDto,
        response: { schema: clientTeamSchema },
        errors: { 404: "CLIENT_NOT_FOUND" },
      },
      auth.require("clients.view"),
      c.team,
    );
    this.put(
      "/:ndid/:userId",
      {
        summary: "Save a team member's phone",
        description:
          "Saved as +<country code><number>; empty clears it. With `addToAlerts` the number also goes on every lead " +
          "source's WhatsApp list of the properties this person may see. Logged.",
        params: TeamMemberParamsDto,
        body: SetTeamPhoneDto,
        response: { schema: clientTeamSchema },
        errors: { 404: "CLIENT_NOT_FOUND, CLIENT_USER_NOT_FOUND" },
      },
      auth.require("clients.edit"),
      c.setPhone,
    );
  }
}
