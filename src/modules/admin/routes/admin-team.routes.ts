import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminTeamController } from "../controllers/admin-team.controller.js";
import {
  AddTeamMemberDto,
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
        description: "They can sign in with Google straight away. Nobody can sign up without this step.",
        body: AddTeamMemberDto,
        response: { status: 201, schema: teamMemberSchema },
        errors: { 409: "TEAM_MEMBER_EXISTS" },
      },
      manage,
      c.add,
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
