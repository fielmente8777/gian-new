import type { Router } from "express";

import type { Mailer } from "../../integrations/mail/mailer.js";
import type { Logger } from "../../shared/logger/logger.js";
import { RateLimiter } from "../../shared/middlewares/rate-limit.middleware.js";
import type { AppModule } from "../../shared/module/app-module.js";
import type { AuthenticateMiddleware } from "../auth/index.js";
import type { NewsletterConfig } from "./config/newsletter.config.js";
import { NewsletterPublicController } from "./controllers/newsletter-public.controller.js";
import { NewsletterController } from "./controllers/newsletter.controller.js";
import { SettingsRepository } from "./repositories/settings.repository.js";
import { SubscriberRepository } from "./repositories/subscriber.repository.js";
import { NewsletterPublicRoutes } from "./routes/newsletter-public.routes.js";
import { NewsletterRoutes } from "./routes/newsletter.routes.js";
import { NewsletterService } from "./services/newsletter.service.js";
import { SignupService } from "./services/signup.service.js";
import { UnsubscribeLinks } from "./services/unsubscribe-links.js";
import type { HotelDirectory, SettingsStore, SubscriberStore } from "./types/newsletter.types.js";

export interface NewsletterModuleDeps {
  config: NewsletterConfig;
  logger: Logger;
  mailer: Mailer;
  /** the auth module's guard: dashboard routes take the dashboard's token */
  auth: AuthenticateMiddleware;
  /** this API's public URL: unsubscribe links point here */
  publicUrl: string;
  /** hotel name and alert emails, by website domain or ndid (profiles + users) */
  hotels: HotelDirectory;
  /** false while the client's subscription has ended or is paused */
  serving: (ndid: string) => Promise<boolean>;
  /** Tests replace the Mongo stores and the clock. */
  overrides?: { subscribers?: SubscriberStore; settings?: SettingsStore; now?: () => Date };
}

/**
 * The hotel's newsletter: the list (shared `Newsletters` collection), the website box, welcome
 * emails, and unsubscribe links. Sending goes through gian's email marketing. See README.md.
 * Owns: `newsletter_settings`; shares `Newsletters` with nexon.
 */
export class NewsletterModule implements AppModule {
  readonly name = "newsletter";
  readonly router: Router;
  /** open CORS: the website box (+ nexon's /editnewsletter) and the unsubscribe page */
  readonly legacyRouter: Router;
  readonly service: NewsletterService;
  readonly signup: SignupService;
  readonly links: UnsubscribeLinks | null;

  private readonly subscribers: SubscriberStore;

  constructor(private readonly deps: NewsletterModuleDeps) {
    const { config, logger, overrides = {} } = deps;
    const now = overrides.now ?? (() => new Date());
    this.subscribers = overrides.subscribers ?? new SubscriberRepository();
    const settings = overrides.settings ?? new SettingsRepository();

    const secret = config.NEWSLETTER_UNSUBSCRIBE_SECRET;
    this.links = secret ? new UnsubscribeLinks(secret, deps.publicUrl) : null;
    if (!this.links) logger.warn("NEWSLETTER_UNSUBSCRIBE_SECRET is not set: newsletter emails go out without an unsubscribe link");

    this.service = new NewsletterService(this.subscribers, settings, now);
    this.signup = new SignupService(this.subscribers, settings, deps.hotels, deps.mailer, this.links, logger, deps.serving, now);

    this.router = new NewsletterRoutes(new NewsletterController(this.service, Boolean(this.links)), deps.auth).router;
    // 10 signups a minute per visitor is plenty for a person and stops a script filling a list
    const signupLimit = RateLimiter.create({ windowMs: 60_000, limit: 10 });
    this.legacyRouter = new NewsletterPublicRoutes(new NewsletterPublicController(this.signup), signupLimit).router;
  }

  async init(): Promise<void> {
    if (!(this.subscribers instanceof SubscriberRepository)) return;
    const warning = await this.subscribers.ensureIndexes();
    if (warning) this.deps.logger.warn(warning);
  }
}
