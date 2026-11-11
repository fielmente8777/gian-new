import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminTeamController } from "../controllers/admin-team.controller.js";
import {
  AddTeamMemberDto,
  invitedMemberSchema,
  teamListSchema,
  teamMemberSchema,
  TeamMemberParamsDto,
  UpdateTeamMemberDto,
} from "../dtos/admin-team.dto.js";
import type { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";

/** /api/v1/admin/team/*, super admins only. */
export class AdminTeamRoutes extends BaseRoutes {
  constructor(c: AdminTeamController, auth: AdminAuthenticateMiddleware) {
    super("/admin/team", { tag: "Admin team" });
    const manage = auth.require("team.manage");

    this.get("/", { summary: "Everyone on the team", response: { schema: teamListSchema } }, manage, c.list);
    this.post(
      "/",
      {
        summary: "Add a staff member",
        description:
          "They can sign in with Google straight away, and get an invite email with the console's link and how to " +
          "sign in. Nobody can sign up without this step. `inviteSent` false: the email failed; resend it.",
        body: AddTeamMemberDto,
        response: { status: 201, schema: invitedMemberSchema },
        errors: { 409: "TEAM_MEMBER_EXISTS" },
      },
      manage,
      c.add,
    );
    this.post(
      "/:id/invite",
      {
        summary: "Email the invite again",
        description: "Same email as when they were added. Logged as team.invite_sent.",
        params: TeamMemberParamsDto,
        response: { schema: invitedMemberSchema },
        errors: { 404: "TEAM_MEMBER_NOT_FOUND", 409: "TEAM_MEMBER_DISABLED" },
      },
      manage,
      c.resendInvite,
    );
    this.patch(
      "/:id",
      {
        summary: "Change a staff member",
        description:
          "Role, status, name, advanced permissions or assigned properties. Disabling someone also ends their " +
          "sessions. Nobody can change their own role or status, and the team keeps at least two active super admins.",
        params: TeamMemberParamsDto,
        body: UpdateTeamMemberDto,
        response: { schema: teamMemberSchema },
        errors: { 404: "TEAM_MEMBER_NOT_FOUND", 409: "CANNOT_CHANGE_OWN_ACCESS, SUPER_ADMIN_MINIMUM" },
      },
      manage,
      c.update,
    );
  }
}
