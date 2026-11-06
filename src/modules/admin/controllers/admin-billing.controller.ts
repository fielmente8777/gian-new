import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import type {
  BillingSettingsBody,
  CreateAppBody,
  CreateOfferBody,
  CreatePlanBody,
  EmailInvoiceBody,
  IdParams,
  OrderParams,
  PaymentListQueryParams,
  UpdateAppBody,
  UpdateOfferBody,
  UpdatePlanBody,
} from "../dtos/admin-billing.dto.js";
import { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";
import type { AdminBillingService } from "../services/admin-billing.service.js";

/** /api/v1/admin/billing: the admin console's Billing, Plans & pricing and Offers screens. */
export class AdminBillingController extends BaseController {
  constructor(private readonly billing: AdminBillingService) {
    super();
  }

  async overview(_req: Request, res: Response): Promise<void> {
    this.ok(res, await this.billing.overview());
  }

  async payments(req: Request, res: Response): Promise<void> {
    const { from, to, ...rest } = req.validated?.query as PaymentListQueryParams;
    const page = await this.billing.payments(AdminAuthenticateMiddleware.of(req), {
      ...rest,
      // whole days, India time
      ...(from ? { from: new Date(`${from}T00:00:00+05:30`) } : {}),
      ...(to ? { to: new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000) } : {}),
    });
    this.ok(res, page);
  }

  async catalogue(_req: Request, res: Response): Promise<void> {
    this.ok(res, await this.billing.catalogue());
  }

  async createPlan(req: Request, res: Response): Promise<void> {
    this.created(res, await this.billing.createPlan(AdminAuthenticateMiddleware.of(req), req.body as CreatePlanBody, req.ip));
  }

  async updatePlan(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.billing.updatePlan(AdminAuthenticateMiddleware.of(req), this.id(req), req.body as UpdatePlanBody, req.ip));
  }

  async createApp(req: Request, res: Response): Promise<void> {
    this.created(res, await this.billing.createApp(AdminAuthenticateMiddleware.of(req), req.body as CreateAppBody, req.ip));
  }

  async updateApp(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.billing.updateApp(AdminAuthenticateMiddleware.of(req), this.id(req), req.body as UpdateAppBody, req.ip));
  }

  async saveSettings(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.billing.saveSettings(AdminAuthenticateMiddleware.of(req), req.body as BillingSettingsBody, req.ip));
  }

  async createOffer(req: Request, res: Response): Promise<void> {
    this.created(res, await this.billing.createOffer(AdminAuthenticateMiddleware.of(req), req.body as CreateOfferBody, req.ip));
  }

  async updateOffer(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.billing.updateOffer(AdminAuthenticateMiddleware.of(req), this.id(req), req.body as UpdateOfferBody, req.ip));
  }

  async invoice(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.billing.invoice(AdminAuthenticateMiddleware.of(req), this.id(req)));
  }

  async invoicePdf(req: Request, res: Response): Promise<void> {
    const { pdf, filename } = await this.billing.invoicePdf(AdminAuthenticateMiddleware.of(req), this.id(req));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).end(pdf);
  }

  async emailInvoice(req: Request, res: Response): Promise<void> {
    const { to } = req.body as EmailInvoiceBody;
    this.ok(res, await this.billing.emailInvoice(AdminAuthenticateMiddleware.of(req), this.id(req), to, req.ip));
  }

  async createInvoice(req: Request, res: Response): Promise<void> {
    const { orderId } = req.validated?.params as OrderParams;
    this.created(res, await this.billing.createInvoice(AdminAuthenticateMiddleware.of(req), orderId, req.ip));
  }

  private id(req: Request): string {
    return (req.validated?.params as IdParams).id;
  }
}
