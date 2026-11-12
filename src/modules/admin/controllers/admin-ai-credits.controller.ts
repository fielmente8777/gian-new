import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import type {
  AdjustCreditsBody,
  AiAuditQuery,
  AiClientListQuery,
  AiClientParams,
  AiSettingsBody,
  BulkGrantBody,
  CostsQuery,
  CreatePackageBody,
  CreatePricingBody,
  CreateTopUpBody,
  IdParams,
  LedgerQuery,
  UpdatePackageBody,
  UpdatePricingBody,
  UpdateTopUpBody,
  WalletStatusBody,
} from "../dtos/admin-ai-credits.dto.js";
import { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";
import type { AdminAiCreditsService } from "../services/admin-ai-credits.service.js";

/** /api/v1/admin/ai-credits: the admin console's AI credits screens. */
export class AdminAiCreditsController extends BaseController {
  constructor(private readonly credits: AdminAiCreditsService) {
    super();
  }

  async overview(_req: Request, res: Response): Promise<void> {
    this.ok(res, await this.credits.overview());
  }

  async clients(req: Request, res: Response): Promise<void> {
    const query = req.validated?.query as AiClientListQuery;
    this.ok(res, await this.credits.clients(AdminAuthenticateMiddleware.of(req), query));
  }

  async client(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as AiClientParams;
    this.ok(res, await this.credits.client(AdminAuthenticateMiddleware.of(req), ndid));
  }

  async ledger(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as AiClientParams;
    const query = req.validated?.query as LedgerQuery;
    this.ok(res, await this.credits.ledger(AdminAuthenticateMiddleware.of(req), ndid, query));
  }

  async adjust(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as AiClientParams;
    const body = req.body as AdjustCreditsBody;
    this.ok(res, await this.credits.adjust(AdminAuthenticateMiddleware.of(req), ndid, body, req.ip));
  }

  async setStatus(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as AiClientParams;
    const body = req.body as WalletStatusBody;
    this.ok(res, await this.credits.setStatus(AdminAuthenticateMiddleware.of(req), ndid, body, req.ip));
  }

  async bulkGrant(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.credits.bulkGrant(AdminAuthenticateMiddleware.of(req), req.body as BulkGrantBody, req.ip));
  }

  async pricing(_req: Request, res: Response): Promise<void> {
    this.ok(res, await this.credits.pricing());
  }

  async createPricing(req: Request, res: Response): Promise<void> {
    const body = req.body as CreatePricingBody;
    this.created(res, await this.credits.createPricing(AdminAuthenticateMiddleware.of(req), body, req.ip));
  }

  async updatePricing(req: Request, res: Response): Promise<void> {
    const { id } = req.validated?.params as IdParams;
    const body = req.body as UpdatePricingBody;
    this.ok(res, await this.credits.updatePricing(AdminAuthenticateMiddleware.of(req), id, body, req.ip));
  }

  async packages(_req: Request, res: Response): Promise<void> {
    this.ok(res, await this.credits.packages());
  }

  async createPackage(req: Request, res: Response): Promise<void> {
    const body = req.body as CreatePackageBody;
    this.created(res, await this.credits.createPackage(AdminAuthenticateMiddleware.of(req), body, req.ip));
  }

  async updatePackage(req: Request, res: Response): Promise<void> {
    const { id } = req.validated?.params as IdParams;
    const body = req.body as UpdatePackageBody;
    this.ok(res, await this.credits.updatePackage(AdminAuthenticateMiddleware.of(req), id, body, req.ip));
  }

  async settings(_req: Request, res: Response): Promise<void> {
    this.ok(res, await this.credits.settings());
  }

  async updateSettings(req: Request, res: Response): Promise<void> {
    const body = req.body as AiSettingsBody;
    this.ok(res, await this.credits.updateSettings(AdminAuthenticateMiddleware.of(req), body, req.ip));
  }

  async topUps(_req: Request, res: Response): Promise<void> {
    this.ok(res, await this.credits.topUps());
  }

  async addTopUp(req: Request, res: Response): Promise<void> {
    const body = req.body as CreateTopUpBody;
    this.created(res, await this.credits.addTopUp(AdminAuthenticateMiddleware.of(req), body, req.ip));
  }

  async editTopUp(req: Request, res: Response): Promise<void> {
    const { id } = req.validated?.params as IdParams;
    const body = req.body as UpdateTopUpBody;
    this.ok(res, await this.credits.editTopUp(AdminAuthenticateMiddleware.of(req), id, body, req.ip));
  }

  async costs(req: Request, res: Response): Promise<void> {
    const { days } = req.validated?.query as CostsQuery;
    this.ok(res, await this.credits.reconcile(days));
  }

  async sync(_req: Request, res: Response): Promise<void> {
    this.ok(res, await this.credits.syncNow());
  }

  async audit(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.credits.gianAudit(req.validated?.query as AiAuditQuery));
  }
}
