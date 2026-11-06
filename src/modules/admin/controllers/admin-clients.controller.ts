import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import {
  ClientResponseDto,
  type ClientListQuery,
  type ClientParams,
  type DeleteClientBody,
  type ClientServiceParams,
  type ClientPropertyParams,
  type SaveNotificationsBody,
  type SetClientServiceBody,
  type UpdateClientBody,
} from "../dtos/admin-clients.dto.js";
import { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";
import type { AdminClientsService } from "../services/admin-clients.service.js";

/** /api/v1/admin/clients/*: the clients screens of the admin console. */
export class AdminClientsController extends BaseController {
  constructor(private readonly clients: AdminClientsService) {
    super();
  }

  async list(req: Request, res: Response): Promise<void> {
    const query = req.validated?.query as ClientListQuery;
    this.ok(res, ClientResponseDto.page(await this.clients.list(AdminAuthenticateMiddleware.of(req), query)));
  }

  async get(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as ClientParams;
    this.ok(res, ClientResponseDto.client(await this.clients.get(AdminAuthenticateMiddleware.of(req), ndid)));
  }

  async openAccount(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as ClientParams;
    const opened = await this.clients.openAccount(AdminAuthenticateMiddleware.of(req), ndid, req.ip);
    res.set("Cache-Control", "no-store");
    this.ok(res, ClientResponseDto.opened(opened));
  }

  async getServices(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as ClientParams;
    this.ok(res, ClientResponseDto.services(await this.clients.getServices(AdminAuthenticateMiddleware.of(req), ndid)));
  }

  async setService(req: Request, res: Response): Promise<void> {
    const { ndid, service } = req.validated?.params as ClientServiceParams;
    const { enabled } = req.body as SetClientServiceBody;
    const view = await this.clients.setService(AdminAuthenticateMiddleware.of(req), ndid, service, enabled, req.ip);
    this.ok(res, ClientResponseDto.services(view));
  }

  async getNotifications(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as ClientParams;
    this.ok(res, await this.clients.getNotifications(AdminAuthenticateMiddleware.of(req), ndid));
  }

  async saveNotifications(req: Request, res: Response): Promise<void> {
    const { ndid, hid } = req.validated?.params as ClientPropertyParams;
    const { sources } = req.body as SaveNotificationsBody;
    this.ok(res, await this.clients.saveNotifications(AdminAuthenticateMiddleware.of(req), ndid, hid, sources, req.ip));
  }

  async deletionPreview(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as ClientParams;
    this.ok(res, await this.clients.deletionPreview(AdminAuthenticateMiddleware.of(req), ndid));
  }

  async delete(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as ClientParams;
    const { confirmName, reason = null } = req.body as DeleteClientBody;
    const result = await this.clients.delete(AdminAuthenticateMiddleware.of(req), ndid, confirmName, reason, req.ip);
    this.ok(res, result);
  }

  async update(req: Request, res: Response): Promise<void> {
    const { ndid } = req.validated?.params as ClientParams;
    const { properties = {}, ...profile } = req.body as UpdateClientBody;
    const client = await this.clients.update(
      AdminAuthenticateMiddleware.of(req),
      ndid,
      { profile, properties },
      req.ip,
    );
    this.ok(res, ClientResponseDto.client(client));
  }
}
