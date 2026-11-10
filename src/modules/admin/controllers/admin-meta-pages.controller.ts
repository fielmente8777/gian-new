import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import type { LinkMetaPageBody, MetaConnectionParams, MetaPageParams } from "../dtos/admin-meta-pages.dto.js";
import { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";
import type { AdminMetaPagesService } from "../services/admin-meta-pages.service.js";

/** /api/v1/admin/meta-pages: the admin console's Meta pages screen. */
export class AdminMetaPagesController extends BaseController {
  constructor(private readonly metaPages: AdminMetaPagesService) {
    super();
  }

  async overview(_req: Request, res: Response): Promise<void> {
    this.ok(res, await this.metaPages.overview());
  }

  async link(req: Request, res: Response): Promise<void> {
    const { pageId } = req.validated?.params as MetaPageParams;
    const body = req.body as LinkMetaPageBody;
    this.ok(res, await this.metaPages.link(AdminAuthenticateMiddleware.of(req), pageId, body, req.ip));
  }

  async unlink(req: Request, res: Response): Promise<void> {
    const { pageId } = req.validated?.params as MetaPageParams;
    this.ok(res, await this.metaPages.unlink(AdminAuthenticateMiddleware.of(req), pageId, req.ip));
  }

  async sync(req: Request, res: Response): Promise<void> {
    const { connectionId } = req.validated?.params as MetaConnectionParams;
    this.ok(res, await this.metaPages.sync(AdminAuthenticateMiddleware.of(req), connectionId, req.ip));
  }
}
