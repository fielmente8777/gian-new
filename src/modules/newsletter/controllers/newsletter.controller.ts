import type { Request, Response } from "express";

import { BaseController } from "../../../shared/http/base-controller.js";
import type {
  AddSubscriberBody,
  AudienceQuery,
  BulkSubscribersBody,
  EditSubscriberBody,
  ExportSubscribersQuery,
  ImportSubscribersBody,
  ListSubscribersQuery,
  SettingsBody,
  SubscriberParams,
} from "../dtos/newsletter.dto.js";
import type { NewsletterService } from "../services/newsletter.service.js";
import type { Subscriber } from "../types/newsletter.types.js";

/** /api/v1/newsletter: the hotel dashboard's Newsletter page. Every call is scoped to the signed-in client. */
export class NewsletterController extends BaseController {
  constructor(
    private readonly newsletter: NewsletterService,
    /** whether emails can carry an unsubscribe link (NEWSLETTER_UNSUBSCRIBE_SECRET set) */
    private readonly unsubscribeLinks: boolean,
  ) {
    super();
  }

  async list(req: Request, res: Response): Promise<void> {
    const { page, limit, ...filter } = req.validated?.query as ListSubscribersQuery;
    const result = await this.newsletter.list(NewsletterController.ndid(req), filter, page, limit);
    this.ok(res, { ...result, items: result.items.map(NewsletterController.view) });
  }

  async stats(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.newsletter.stats(NewsletterController.ndid(req)));
  }

  async tags(req: Request, res: Response): Promise<void> {
    this.ok(res, await this.newsletter.tags(NewsletterController.ndid(req)));
  }

  async add(req: Request, res: Response): Promise<void> {
    const subscriber = await this.newsletter.add(NewsletterController.ndid(req), req.body as AddSubscriberBody);
    this.created(res, NewsletterController.view(subscriber));
  }

  async edit(req: Request, res: Response): Promise<void> {
    const { id } = req.validated?.params as SubscriberParams;
    const subscriber = await this.newsletter.edit(NewsletterController.ndid(req), id, req.body as EditSubscriberBody);
    this.ok(res, NewsletterController.view(subscriber));
  }

  async bulk(req: Request, res: Response): Promise<void> {
    const { ids, action, tags } = req.body as BulkSubscribersBody;
    this.ok(res, await this.newsletter.bulk(NewsletterController.ndid(req), ids, action, tags));
  }

  async import(req: Request, res: Response): Promise<void> {
    const { rows, tags } = req.body as ImportSubscribersBody;
    this.ok(res, await this.newsletter.import(NewsletterController.ndid(req), rows, tags));
  }

  async audience(req: Request, res: Response): Promise<void> {
    const { tag } = (req.validated?.query ?? {}) as AudienceQuery;
    const emails = await this.newsletter.audience(NewsletterController.ndid(req), tag);
    this.ok(res, { emails, count: emails.length });
  }

  async export(req: Request, res: Response): Promise<void> {
    const filter = (req.validated?.query ?? {}) as ExportSubscribersQuery;
    const csv = await this.newsletter.exportCsv(NewsletterController.ndid(req), filter);
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="newsletter-subscribers-${day}.csv"`);
    res.status(200).send(csv);
  }

  async settings(req: Request, res: Response): Promise<void> {
    const settings = await this.newsletter.settings(NewsletterController.ndid(req));
    this.ok(res, { ...settings, unsubscribeLinks: this.unsubscribeLinks });
  }

  async saveSettings(req: Request, res: Response): Promise<void> {
    const settings = await this.newsletter.saveSettings(NewsletterController.ndid(req), req.body as SettingsBody);
    this.ok(res, { ...settings, unsubscribeLinks: this.unsubscribeLinks });
  }

  private static ndid(req: Request): string {
    return req.auth!.ndid;
  }

  /** The row as the dashboard sees it (no ndid). */
  private static view({ ndid: _ndid, updatedAt: _updatedAt, ...subscriber }: Subscriber) {
    return subscriber;
  }
}
