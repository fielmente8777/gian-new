import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import type { ZohoApplyBody, ZohoCreateInvoiceBody } from "../dtos/admin-zoho.dto.js";
import { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";
import type { AdminZohoService, PaymentProvider } from "../services/admin-zoho.service.js";

/** /api/v1/admin/zoho: the admin console's Billing → Zoho Books screen. */
export class AdminZohoController extends BaseController {
  constructor(private readonly zoho: AdminZohoService) {
    super();
  }

  async status(_req: Request, res: Response): Promise<void> {
    this.ok(res, await this.zoho.status());
  }

  async connect(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.zoho.connect(AdminAuthenticateMiddleware.of(req), req.ip));
  }

  async disconnect(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.zoho.disconnect(AdminAuthenticateMiddleware.of(req), req.ip));
  }

  async taxes(_req: Request, res: Response): Promise<void> {
    this.ok(res, { items: await this.zoho.taxes() });
  }

  async setTax(req: Request, res: Response): Promise<void> {
    const { taxId } = req.body as { taxId: string | null };
    this.ok(res, await this.zoho.setTax(AdminAuthenticateMiddleware.of(req), taxId, req.ip));
  }

  async setProvider(req: Request, res: Response): Promise<void> {
    const { provider } = req.body as { provider: PaymentProvider };
    this.ok(res, await this.zoho.setProvider(AdminAuthenticateMiddleware.of(req), provider, req.ip));
  }

  async customers(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.zoho.customers(AdminAuthenticateMiddleware.of(req)));
  }

  async link(req: Request, res: Response): Promise<void> {
    const { contactId } = req.body as { contactId: string };
    this.ok(res, await this.zoho.link(AdminAuthenticateMiddleware.of(req), this.ndid(req), contactId, req.ip));
  }

  async unlink(req: Request, res: Response): Promise<void> {
    await this.zoho.unlink(AdminAuthenticateMiddleware.of(req), this.ndid(req), req.ip);
    this.ok(res, { unlinked: true });
  }

  async createCustomer(req: Request, res: Response): Promise<void> {
    this.created(res, await this.zoho.createCustomer(AdminAuthenticateMiddleware.of(req), this.ndid(req), req.ip));
  }

  async invoices(req: Request, res: Response): Promise<void> {
    const { state, limit } = req.validated?.query as { state: "review" | "applied" | "open" | "all"; limit: number };
    this.ok(res, { items: await this.zoho.invoices(AdminAuthenticateMiddleware.of(req), state, limit) });
  }

  async apply(req: Request, res: Response): Promise<void> {
    this.ok(
      res,
      await this.zoho.apply(
        AdminAuthenticateMiddleware.of(req),
        this.invoiceId(req),
        req.body as ZohoApplyBody,
        req.ip,
      ),
    );
  }

  async ignore(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.zoho.ignore(AdminAuthenticateMiddleware.of(req), this.invoiceId(req), req.ip));
  }

  async sync(_req: Request, res: Response): Promise<void> {
    this.ok(res, await this.zoho.syncNow());
  }

  async createInvoice(req: Request, res: Response): Promise<void> {
    const body = req.body as ZohoCreateInvoiceBody;
    this.created(
      res,
      await this.zoho.createInvoice(
        AdminAuthenticateMiddleware.of(req),
        this.ndid(req),
        { ...body, offerCode: body.offerCode ?? null },
        req.ip,
      ),
    );
  }

  private ndid(req: Request): string {
    return (req.validated?.params as { ndid: string }).ndid;
  }

  private invoiceId(req: Request): string {
    return (req.validated?.params as { invoiceId: string }).invoiceId;
  }
}
