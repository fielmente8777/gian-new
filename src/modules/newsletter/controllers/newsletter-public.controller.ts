import type { Request, Response } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import { BaseController } from "../../../shared/http/base-controller.js";
import type { PublicSubscribeBody } from "../dtos/newsletter.dto.js";
import type { SignupService } from "../services/signup.service.js";
import { UnsubscribePage } from "../services/unsubscribe-page.js";

const NEXON_MESSAGES: Record<string, string> = {
  INVALID_EMAIL: "Please enter a valid email address",
  UNKNOWN_WEBSITE: "Some error occured",
};

/**
 * Paths hotel websites and guests reach without a login, served with open CORS (any hotel domain):
 * the newsletter box, nexon's old /editnewsletter, and the unsubscribe page.
 */
export class NewsletterPublicController extends BaseController {
  constructor(private readonly signup: SignupService) {
    super();
  }

  /** POST /newsletter/subscribe { site, email, name? } */
  async subscribe(req: Request, res: Response): Promise<void> {
    const body = req.body as PublicSubscribeBody;
    const status = await this.signup.subscribe({ site: body.site ?? body.Domain ?? "", email: body.email, name: body.name });
    this.ok(res, { status });
  }

  /**
   * POST /editnewsletter { Domain, email }: nexon's path, still called by every hotel website.
   * Always 200 with nexon's `{ Status, Message }` (its message text included), so the websites
   * keep working unchanged once nginx sends this path here.
   */
  async legacySubscribe(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Partial<PublicSubscribeBody>;
    try {
      await this.signup.subscribe({
        site: String(body.Domain ?? body.site ?? ""),
        email: String(body.email ?? ""),
        name: typeof body.name === "string" ? body.name : null,
      });
      res.status(200).json({ Status: true, Message: "Newsletter Added" });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      res.locals.rateLimitFailure = true;
      res.status(200).json({ Status: false, Message: NEXON_MESSAGES[error.code] ?? "Some error occured" });
    }
  }

  /** GET /newsletter/unsubscribe?t= : the confirm page (changes nothing) */
  async unsubscribePage(req: Request, res: Response): Promise<void> {
    const token = NewsletterPublicController.token(req);
    const target = await this.signup.preview(token);
    NewsletterPublicController.html(
      res,
      target ? 200 : 400,
      target ? UnsubscribePage.confirm({ token: token!, ...target }) : UnsubscribePage.invalid(),
    );
  }

  /**
   * POST /newsletter/unsubscribe?t= : the confirm button, and mail apps' one-click unsubscribe
   * (RFC 8058: body `List-Unsubscribe=One-Click`).
   */
  async unsubscribe(req: Request, res: Response): Promise<void> {
    const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
    const done = await this.signup.unsubscribe(NewsletterPublicController.token(req), reason);
    NewsletterPublicController.html(
      res,
      done ? 200 : 400,
      done ? UnsubscribePage.done(done.email, done.hotelName) : UnsubscribePage.invalid(),
    );
  }

  private static token(req: Request): string | undefined {
    const t = req.query.t;
    return typeof t === "string" ? t : undefined;
  }

  private static html(res: Response, status: number, html: string): void {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    // the page has no scripts; nothing else may load or frame it
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    res.status(status).send(html);
  }
}
