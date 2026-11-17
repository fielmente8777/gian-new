import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import { IMPORT_LIMIT } from "../services/newsletter.service.js";
import { SUBSCRIBER_SOURCES, SUBSCRIBER_STATUSES } from "../types/newsletter.types.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const email = z.string().trim().min(3).max(254);
const name = z.string().trim().max(120).nullable().optional();
const tag = z.string().trim().min(1).max(40);
const tags = z.array(tag).max(20);

const filter = {
  status: z.enum(SUBSCRIBER_STATUSES).optional(),
  source: z.enum(SUBSCRIBER_SOURCES).optional(),
  tag: tag.optional(),
  search: z.string().trim().max(120).optional(),
};

export class ListSubscribersQueryDto extends BaseDto {
  static override readonly schema = z.object({
    ...filter,
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
  });
}
export type ListSubscribersQuery = z.infer<typeof ListSubscribersQueryDto.schema>;

export class ExportSubscribersQueryDto extends BaseDto {
  static override readonly schema = z.object(filter);
}
export type ExportSubscribersQuery = z.infer<typeof ExportSubscribersQueryDto.schema>;

export class AudienceQueryDto extends BaseDto {
  static override readonly schema = z.object({ tag: tag.optional() });
}
export type AudienceQuery = z.infer<typeof AudienceQueryDto.schema>;

export class SubscriberParamsDto extends BaseDto {
  static override readonly schema = z.object({ id: objectId });
}
export type SubscriberParams = z.infer<typeof SubscriberParamsDto.schema>;

export class AddSubscriberDto extends BaseDto {
  static override readonly schema = z.object({ email, name, tags: tags.default([]) });
}
export type AddSubscriberBody = z.infer<typeof AddSubscriberDto.schema>;

export class EditSubscriberDto extends BaseDto {
  static override readonly schema = z.object({
    name,
    tags: tags.optional(),
    status: z.enum(SUBSCRIBER_STATUSES).optional(),
  });
}
export type EditSubscriberBody = z.infer<typeof EditSubscriberDto.schema>;

export class BulkSubscribersDto extends BaseDto {
  static override readonly schema = z.object({
    ids: z.array(objectId).min(1).max(1000),
    action: z.enum(["delete", "unsubscribe", "resubscribe", "addTags", "removeTags"]),
    tags: tags.default([]).meta({ description: "for addTags / removeTags" }),
  });
}
export type BulkSubscribersBody = z.infer<typeof BulkSubscribersDto.schema>;

export class ImportSubscribersDto extends BaseDto {
  static override readonly schema = z.object({
    // emails are checked one by one in the service, so one bad row doesn't reject the file
    rows: z
      .array(z.object({ email: z.string().max(320), name: z.string().max(200).nullable().optional() }))
      .min(1)
      .max(IMPORT_LIMIT),
    tags: tags.default([]).meta({ description: "added to every imported row" }),
  });
}
export type ImportSubscribersBody = z.infer<typeof ImportSubscribersDto.schema>;

export class SettingsDto extends BaseDto {
  static override readonly schema = z.object({
    welcome: z.object({
      enabled: z.boolean(),
      subject: z.string().trim().min(1).max(200),
      message: z.string().trim().min(1).max(5000),
    }),
    notifyOnSignup: z.boolean(),
  });
}
export type SettingsBody = z.infer<typeof SettingsDto.schema>;

/** The website box. `Domain` is what nexon's /editnewsletter takes; `site` is the same thing. */
export class PublicSubscribeDto extends BaseDto {
  static override readonly schema = z.object({
    email: z.string().max(320),
    name: z.string().max(120).nullable().optional(),
    site: z.string().max(255).optional(),
    Domain: z.string().max(255).optional(),
  });
}
export type PublicSubscribeBody = z.infer<typeof PublicSubscribeDto.schema>;

export class UnsubscribeQueryDto extends BaseDto {
  static override readonly schema = z.object({ t: z.string().max(1000).optional() });
}

// --- responses (docs) ---

export const subscriberSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  status: z.enum(SUBSCRIBER_STATUSES),
  source: z.enum(SUBSCRIBER_SOURCES),
  tags: z.array(z.string()),
  subscribedAt: z.string(),
  unsubscribedAt: z.string().nullable(),
  unsubscribedBy: z.enum(["subscriber", "hotel"]).nullable(),
  unsubscribeReason: z.string().nullable(),
});

export const subscriberPageSchema = z.object({
  items: z.array(subscriberSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

export const statsSchema = z.object({
  total: z.number(),
  subscribed: z.number(),
  unsubscribed: z.number(),
  newLast30Days: z.number(),
  unsubscribedLast30Days: z.number(),
  months: z.array(z.object({ month: z.string(), subscribed: z.number(), unsubscribed: z.number() })),
  bySource: z.record(z.string(), z.number()),
});

export const importResultSchema = z.object({
  added: z.number(),
  updated: z.number(),
  skippedUnsubscribed: z.number(),
  invalid: z.number(),
  duplicatesInFile: z.number(),
});

export const settingsSchema = z.object({
  welcome: z.object({ enabled: z.boolean(), subject: z.string(), message: z.string() }),
  notifyOnSignup: z.boolean(),
  unsubscribeLinks: z.boolean().meta({ description: "false while the server has no NEWSLETTER_UNSUBSCRIBE_SECRET" }),
  updatedAt: z.string().nullable(),
});
