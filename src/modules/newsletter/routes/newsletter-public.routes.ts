import type { RequestHandler } from "express";
import { z } from "zod";

import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { NewsletterPublicController } from "../controllers/newsletter-public.controller.js";
import { PublicSubscribeDto, UnsubscribeQueryDto } from "../dtos/newsletter.dto.js";

/**
 * Paths without a login, mounted at the root with open CORS, because every hotel website (any
 * domain) posts its newsletter box here and guests open the unsubscribe link from their mail app.
 */
export class NewsletterPublicRoutes extends BaseRoutes {
  constructor(c: NewsletterPublicController, signupLimit: RequestHandler) {
    super("/", { tag: "Newsletter (public)" });

    this.post(
      "/newsletter/subscribe",
      {
        summary: "The website's newsletter box",
        description:
          "`site` is the website's domain (`Domain` works too). Signing up again after unsubscribing is allowed. " +
          "status: subscribed | already_subscribed | resubscribed.",
        body: PublicSubscribeDto,
        response: { schema: z.object({ status: z.enum(["subscribed", "already_subscribed", "resubscribed"]) }) },
        errors: { 400: "INVALID_EMAIL", 404: "UNKNOWN_WEBSITE" },
      },
      signupLimit,
      c.subscribe,
    );
    this.post(
      "/editnewsletter",
      {
        summary: "nexon's newsletter box path { Domain, email }",
        description:
          "What hotel websites call today. Only gets traffic once nginx sends this path here; until then nexon " +
          "answers it. Always 200 with `{ Status, Message }`. Use `POST /newsletter/subscribe` in new code.",
        tags: ["Legacy (nexon)"],
        body: PublicSubscribeDto,
        envelope: false,
        validate: false,
        deprecated: true,
        response: { schema: z.object({ Status: z.boolean(), Message: z.string() }) },
      },
      signupLimit,
      c.legacySubscribe,
    );
    this.get(
      "/newsletter/unsubscribe",
      {
        summary: "Unsubscribe confirm page (HTML)",
        description: "Opened from the link in an email. Shows a button only: link scanners open every link, so GET changes nothing.",
        query: UnsubscribeQueryDto,
        envelope: false,
        response: { description: "text/html" },
      },
      c.unsubscribePage,
    );
    this.post(
      "/newsletter/unsubscribe",
      {
        summary: "Unsubscribe (the confirm button, and mail apps' one-click unsubscribe)",
        description: "Form body: optional `reason`; RFC 8058 one-click sends `List-Unsubscribe=One-Click`.",
        query: UnsubscribeQueryDto,
        envelope: false,
        validate: false,
        response: { description: "text/html" },
      },
      c.unsubscribe,
    );
  }
}
