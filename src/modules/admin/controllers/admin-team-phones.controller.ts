import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import type { ClientParams } from "../dtos/admin-clients.dto.js";
import type { FixOwnerPhonesBody, SetTeamPhoneBody, TeamMemberParams } from "../dtos/admin-team-phones.dto.js";
import { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";
import type { AdminTeamPhonesService } from "../services/admin-team-phones.service.js";

/** A client's team and their WhatsApp numbers, and account holders with no number. */
export class AdminTeamPhonesController extends BaseController {
  constructor(private readonly teamPhones: AdminTeamPhonesService) {
    super();
  }

  async team(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as ClientParams;
    this.ok(res, await this.teamPhones.team(AdminAuthenticateMiddleware.of(req), ndid));
  }

  async setPhone(req: Request, res: Response): Promise<void> {
    const { ndid, userId } = req.validated?.params as TeamMemberParams;
    const { phone, addToAlerts } = req.body as SetTeamPhoneBody;
    const admin = AdminAuthenticateMiddleware.of(req);
    this.ok(res, await this.teamPhones.setPhone(admin, ndid, userId, phone, addToAlerts, req.ip));
  }

  async missingOwners(req: Request, res: Response): Promise<void> {
    this.ok(res, { items: await this.teamPhones.ownersMissingPhone(AdminAuthenticateMiddleware.of(req)) });
  }

  async fixOwners(req: Request, res: Response): Promise<void> {
    const { ndids } = req.body as FixOwnerPhonesBody;
    const admin = AdminAuthenticateMiddleware.of(req);
    this.ok(res, { results: await this.teamPhones.fixOwners(admin, ndids, req.ip) });
  }
}
