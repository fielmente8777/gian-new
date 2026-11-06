import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import { AuditResponseDto, type AdminAuditQueryParams } from "../dtos/admin-audit.dto.js";
import type { AdminAuditService } from "../services/admin-audit.service.js";

/** /api/v1/admin/audit-log: the activity screen of the admin console. */
export class AdminAuditController extends BaseController {
  constructor(private readonly audit: AdminAuditService) {
    super();
  }

  async list(req: Request, res: Response): Promise<void> {
    const query = req.validated?.query as AdminAuditQueryParams;
    this.ok(res, AuditResponseDto.page(await this.audit.list(query)));
  }
}
