import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import {
  SubscriptionResponseDto,
  type ChangePlanBody,
  type RenewSubscriptionBody,
  type SetAppsBody,
  type StopSubscriptionBody,
  type SubscriptionListQueryParams,
  type SubscriptionParams,
} from "../dtos/admin-subscriptions.dto.js";
import { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";
import type { AdminSubscriptionsService } from "../services/admin-subscriptions.service.js";

/** /api/v1/admin/plans and /api/v1/admin/subscriptions: the subscriptions screens of the admin console. */
export class AdminSubscriptionsController extends BaseController {
  constructor(private readonly subscriptions: AdminSubscriptionsService) {
    super();
  }

  async apps(_req: Request, res: Response): Promise<void> {
    this.ok(res, SubscriptionResponseDto.apps(await this.subscriptions.appCatalogue()));
  }

  async setApps(req: Request, res: Response): Promise<void> {
    const { apps } = req.body as SetAppsBody;
    const view = await this.subscriptions.setApps(
      AdminAuthenticateMiddleware.of(req),
      this.ndid(req),
      // a chosen last day lasts to its end, India time
      apps.map((a) => ({ appId: a.appId, endDate: new Date(`${a.endDate}T23:59:59.999+05:30`), isTrial: a.isTrial })),
      req.ip,
    );
    this.ok(res, SubscriptionResponseDto.view(view));
  }

  async plans(_req: Request, res: Response): Promise<void> {
    this.ok(res, SubscriptionResponseDto.plans(await this.subscriptions.plans()));
  }

  async list(req: Request, res: Response): Promise<void> {
    const query = req.validated?.query as SubscriptionListQueryParams;
    const page = await this.subscriptions.list(AdminAuthenticateMiddleware.of(req), query);
    this.ok(res, SubscriptionResponseDto.page(page));
  }

  async get(req: Request, res: Response): Promise<void> {
    this.ok(
      res,
      SubscriptionResponseDto.view(await this.subscriptions.get(AdminAuthenticateMiddleware.of(req), this.ndid(req))),
    );
  }

  async pause(req: Request, res: Response): Promise<void> {
    const { reason = null, endApps } = req.body as StopSubscriptionBody;
    const view = await this.subscriptions.pause(
      AdminAuthenticateMiddleware.of(req),
      this.ndid(req),
      reason,
      req.ip,
      endApps,
    );
    this.ok(res, SubscriptionResponseDto.view(view));
  }

  async resume(req: Request, res: Response): Promise<void> {
    const view = await this.subscriptions.resume(AdminAuthenticateMiddleware.of(req), this.ndid(req), req.ip);
    this.ok(res, SubscriptionResponseDto.view(view));
  }

  async renew(req: Request, res: Response): Promise<void> {
    const { months, until, planId, note = null, extendApps } = req.body as RenewSubscriptionBody;
    // a chosen last day lasts to its end, India time
    const term = until ? { until: new Date(`${until}T23:59:59.999+05:30`) } : { months: months! };
    const view = await this.subscriptions.renew(
      AdminAuthenticateMiddleware.of(req),
      this.ndid(req),
      term,
      planId ?? null,
      note,
      req.ip,
      extendApps,
    );
    this.ok(res, SubscriptionResponseDto.view(view));
  }

  async expire(req: Request, res: Response): Promise<void> {
    const { reason = null, endApps } = req.body as StopSubscriptionBody;
    const view = await this.subscriptions.expire(
      AdminAuthenticateMiddleware.of(req),
      this.ndid(req),
      reason,
      req.ip,
      endApps,
    );
    this.ok(res, SubscriptionResponseDto.view(view));
  }

  async changePlan(req: Request, res: Response): Promise<void> {
    const { planId } = req.body as ChangePlanBody;
    const view = await this.subscriptions.changePlan(
      AdminAuthenticateMiddleware.of(req),
      this.ndid(req),
      planId,
      req.ip,
    );
    this.ok(res, SubscriptionResponseDto.view(view));
  }

  private ndid(req: Request): string {
    return (req.validated?.params as SubscriptionParams).ndid;
  }
}
