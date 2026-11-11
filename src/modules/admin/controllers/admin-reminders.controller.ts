import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import {
  RemindersResponseDto,
  type ReminderLogQuery,
  type ReminderSettingsBody,
  type SendRemindersBody,
} from "../dtos/admin-reminders.dto.js";
import { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";
import type { AdminRemindersService } from "../services/admin-reminders.service.js";

/** /api/v1/admin/reminders: the admin console's Billing → Reminders screen. */
export class AdminRemindersController extends BaseController {
  constructor(private readonly reminders: AdminRemindersService) {
    super();
  }

  async overview(_req: Request, res: Response): Promise<void> {
    this.ok(res, RemindersResponseDto.overview(await this.reminders.overview()));
  }

  async saveSettings(req: Request, res: Response): Promise<void> {
    const overview = await this.reminders.saveSettings(
      AdminAuthenticateMiddleware.of(req),
      req.body as ReminderSettingsBody,
      req.ip,
    );
    this.ok(res, RemindersResponseDto.overview(overview));
  }

  async upcoming(req: Request, res: Response): Promise<void> {
    const { days } = req.validated?.query as { days: number };
    this.ok(
      res,
      RemindersResponseDto.upcoming(await this.reminders.upcoming(AdminAuthenticateMiddleware.of(req), days)),
    );
  }

  async history(req: Request, res: Response): Promise<void> {
    const { limit, ndid, before } = req.validated?.query as ReminderLogQuery;
    const rows = await this.reminders.history(AdminAuthenticateMiddleware.of(req), {
      limit,
      ...(ndid ? { ndid } : {}),
      ...(before ? { before: new Date(before) } : {}),
    });
    this.ok(res, { items: rows.map((r) => RemindersResponseDto.entry(r)) });
  }

  async send(req: Request, res: Response): Promise<void> {
    const { ndids } = req.body as SendRemindersBody;
    const { results, sent } = await this.reminders.sendNow(AdminAuthenticateMiddleware.of(req), ndids, req.ip);
    this.ok(res, {
      sent,
      results: results.map((r) => ({ ...r, entry: r.entry ? RemindersResponseDto.entry(r.entry) : null })),
    });
  }
}
