import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import {
  TeamResponseDto,
  type AddTeamMemberBody,
  type TeamMemberParams,
  type UpdateTeamMemberBody,
} from "../dtos/admin-team.dto.js";
import { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";
import type { AdminTeamService, TeamAction } from "../services/admin-team.service.js";

/** /api/v1/admin/team/*: the team screen of the admin console. */
export class AdminTeamController extends BaseController {
  constructor(private readonly team: AdminTeamService) {
    super();
  }

  async list(_req: Request, res: Response): Promise<void> {
    this.ok(res, TeamResponseDto.list(await this.team.list()));
  }

  async add(req: Request, res: Response): Promise<void> {
    const member = await this.team.add(req.body as AddTeamMemberBody, AdminTeamController.action(req));
    this.created(res, TeamResponseDto.member(member));
  }

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.validated?.params as TeamMemberParams;
    const member = await this.team.update(id, req.body as UpdateTeamMemberBody, AdminTeamController.action(req));
    this.ok(res, TeamResponseDto.member(member));
  }

  private static action(req: Request): TeamAction {
    return { actor: AdminAuthenticateMiddleware.of(req), ip: req.ip };
  }
}
