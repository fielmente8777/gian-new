import { z } from "zod";

import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AuthenticateMiddleware } from "../../auth/index.js";
import type { NewsletterController } from "../controllers/newsletter.controller.js";
import {
  AddSubscriberDto,
  AudienceQueryDto,
  BulkSubscribersDto,
  EditSubscriberDto,
  ExportSubscribersQueryDto,
  ImportSubscribersDto,
  importResultSchema,
  ListSubscribersQueryDto,
  SettingsDto,
  settingsSchema,
  statsSchema,
  SubscriberParamsDto,
  subscriberPageSchema,
  subscriberSchema,
} from "../dtos/newsletter.dto.js";

/** /api/v1/newsletter/*: the dashboard's Newsletter page. The list is per client (ndid), across its properties. */
export class NewsletterRoutes extends BaseRoutes {
  constructor(c: NewsletterController, auth: AuthenticateMiddleware) {
    super("/newsletter", { tag: "Newsletter" });
    const signedIn = auth.require();

    this.get(
      "/subscribers",
      {
        summary: "The newsletter list, newest first",
        description: "Filter by status, source, tag, or a search on email and name.",
        query: ListSubscribersQueryDto,
        response: { schema: subscriberPageSchema },
      },
      signedIn,
      c.list,
    );
    this.get(
      "/subscribers/export",
      {
        summary: "The list (same filters) as a CSV file",
        query: ExportSubscribersQueryDto,
        envelope: false,
        response: { description: "text/csv, UTF-8 with BOM (opens in Excel)" },
      },
      signedIn,
      c.export,
    );
    this.get(
      "/audience",
      {
        summary: "Addresses a newsletter goes to",
        description:
          "Everyone subscribed (or only those with `tag`), deduplicated. The dashboard hands them to " +
          "gian's email marketing (manual recipient batch) to send.",
        query: AudienceQueryDto,
        response: { schema: z.object({ emails: z.array(z.string()), count: z.number() }) },
      },
      signedIn,
      c.audience,
    );
    this.post(
      "/subscribers",
      {
        summary: "Add one subscriber by hand",
        body: AddSubscriberDto,
        response: { status: 201, schema: subscriberSchema },
        errors: { 400: "INVALID_EMAIL", 409: "SUBSCRIBER_EXISTS, SUBSCRIBER_OPTED_OUT" },
      },
      signedIn,
      c.add,
    );
    this.post(
      "/subscribers/import",
      {
        summary: "Import rows read from a CSV / Excel file",
        description:
          "Up to 10,000 rows. Existing addresses get the name and tags filled in; addresses that unsubscribed " +
          "stay unsubscribed (counted in skippedUnsubscribed).",
        body: ImportSubscribersDto,
        response: { schema: importResultSchema },
      },
      signedIn,
      c.import,
    );
    this.post(
      "/subscribers/bulk",
      {
        summary: "Delete, unsubscribe, resubscribe or tag many at once",
        description: "resubscribe skips people who unsubscribed themselves.",
        body: BulkSubscribersDto,
        response: { schema: z.object({ changed: z.number(), skipped: z.number() }) },
      },
      signedIn,
      c.bulk,
    );
    this.patch(
      "/subscribers/:id",
      {
        summary: "Change a subscriber's name, tags or status",
        params: SubscriberParamsDto,
        body: EditSubscriberDto,
        response: { schema: subscriberSchema },
        errors: { 404: "SUBSCRIBER_NOT_FOUND", 409: "SUBSCRIBER_OPTED_OUT" },
      },
      signedIn,
      c.edit,
    );
    this.get(
      "/stats",
      {
        summary: "Totals, the last 30 days, 12 months of growth and where people came from",
        response: { schema: statsSchema },
      },
      signedIn,
      c.stats,
    );
    this.get(
      "/tags",
      { summary: "Every tag used on the list", response: { schema: z.array(z.string()) } },
      signedIn,
      c.tags,
    );
    this.get(
      "/settings",
      { summary: "Welcome email and signup alert settings", response: { schema: settingsSchema } },
      signedIn,
      c.settings,
    );
    this.put(
      "/settings",
      {
        summary: "Save the welcome email and signup alert settings",
        description: "In the welcome email, {{name}} and {{hotel}} are filled in.",
        body: SettingsDto,
        response: { schema: settingsSchema },
      },
      signedIn,
      c.saveSettings,
    );
  }
}
