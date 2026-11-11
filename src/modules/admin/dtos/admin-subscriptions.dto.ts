import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import type { AppRecord, PlanRecord, SubscriptionPage, SubscriptionRecord } from "../../subscriptions/index.js";
import type { SubscriptionView } from "../services/admin-subscriptions.service.js";

const ndid = z.string().trim().min(1).max(64);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid plan id");
const reason = z
  .string()
  .trim()
  .max(500)
  .transform((value) => value || null)
  .nullable()
  .optional();

export class SubscriptionListQueryDto extends BaseDto {
  static override readonly schema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    kind: z.enum(["clients", "test"]).default("clients").meta({
      description:
        "clients = real hotels; test = Eazotel's own test dashboards (owner or hotel email on ADMIN_TEST_EMAIL_DOMAINS)",
    }),
    pageSize: z.coerce.number().int().min(5).max(100).default(25),
    sort: z.enum(["hotel", "plan", "endDate", "state"]).default("endDate"),
    order: z.enum(["asc", "desc"]).default("asc"),
    state: z
      .enum(["active", "ending", "ended", "stopped"])
      .optional()
      .meta({ description: "ending = within 7 days; stopped = paused or expired by staff" }),
    search: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((value) => value || undefined)
      .meta({ description: "part of the hotel name, or an exact ndid" }),
  });
}
export type SubscriptionListQueryParams = z.infer<typeof SubscriptionListQueryDto.schema>;

export class SubscriptionParamsDto extends BaseDto {
  static override readonly schema = z.object({ ndid });
}
export type SubscriptionParams = z.infer<typeof SubscriptionParamsDto.schema>;

export class StopSubscriptionDto extends BaseDto {
  static override readonly schema = z.object({
    reason,
    endApps: z
      .boolean()
      .default(false)
      .meta({ description: "also end every app now (resume or renew extends them again)" }),
  });
}
export type StopSubscriptionBody = z.infer<typeof StopSubscriptionDto.schema>;

export class RenewSubscriptionDto extends BaseDto {
  static override readonly schema = z
    .object({
      months: z
        .number()
        .int()
        .min(1)
        .max(36)
        .optional()
        .meta({ description: "added to the current end, or to today if it has passed" }),
      until: z.iso.date().optional().meta({ description: "an exact last day instead of months, e.g. 2027-03-31" }),
      planId: objectId.optional().meta({ description: "also move to this plan (upgrade or downgrade)" }),
      note: reason.meta({ description: "e.g. paid by bank transfer, invoice 1042" }),
      extendApps: z
        .boolean()
        .default(true)
        .meta({ description: "also move every app the hotel has to the new end date (default true)" }),
    })
    .refine((body) => (body.months === undefined) !== (body.until === undefined), {
      error: "Send either months or until",
    })
    .refine((body) => !body.until || new Date(`${body.until}T23:59:59.999+05:30`) > new Date(), {
      error: "The new end date must be in the future",
      path: ["until"],
    });
}
export type RenewSubscriptionBody = z.infer<typeof RenewSubscriptionDto.schema>;

export class SetAppsDto extends BaseDto {
  static override readonly schema = z.object({
    apps: z
      .array(
        z.object({
          appId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid app id"),
          endDate: z.iso.date().meta({ description: "last day, e.g. 2027-03-31" }),
          isTrial: z.boolean().default(false),
        }),
      )
      .max(50)
      .refine((apps) => new Set(apps.map((a) => a.appId)).size === apps.length, { error: "An app is listed twice" })
      .meta({ description: "exactly the apps the hotel should have; anything not listed is removed and turned off" }),
  });
}
export type SetAppsBody = z.infer<typeof SetAppsDto.schema>;

export class ChangePlanDto extends BaseDto {
  static override readonly schema = z.object({ planId: objectId });
}
export type ChangePlanBody = z.infer<typeof ChangePlanDto.schema>;

// ── responses ───────────────────────────────────────────────────────────────

const planSchema = z.object({ id: z.string(), name: z.string(), price: z.number() });
export const planListSchema = z.object({ plans: z.array(planSchema) });

const subscriptionSchema = z.object({
  ndid: z.string(),
  hotelName: z.string().nullable(),
  plan: planSchema.nullable(),
  status: z.enum(["ACTIVE", "EXPIRED", "CANCELLED", "TRIAL"]),
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
  autoRenew: z.boolean(),
  staffStop: z
    .object({
      kind: z.enum(["paused", "expired"]),
      at: z.iso.datetime(),
      by: z.string(),
      reason: z.string().nullable(),
      daysLeftWhenPaused: z.number().nullable(),
      appsEnded: z.boolean(),
    })
    .nullable()
    .meta({ description: "set while staff have paused or expired it; services stay off until resume or renew" }),
  apps: z.array(
    z.object({
      appId: z.string(),
      name: z.string().nullable(),
      code: z.string().nullable(),
      isTrial: z.boolean(),
      startDate: z.iso.datetime(),
      endDate: z.iso.datetime(),
    }),
  ),
  appAccess: z.record(z.string(), z.boolean()).meta({ description: "what the hotel dashboard unlocks, by app code" }),
});

const appSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  price: z.number(),
  isActive: z.boolean(),
});
export const appListSchema = z.object({ apps: z.array(appSchema) });

const stateEnum = z.enum(["active", "ending", "ended", "stopped"]);

export const subscriptionPageSchema = z.object({
  items: z.array(subscriptionSchema.extend({ state: stateEnum })),
  total: z.number().meta({ description: "matching every filter, for paging" }),
  counts: z
    .object({ all: z.number(), active: z.number(), ending: z.number(), ended: z.number(), stopped: z.number() })
    .meta({ description: "per state, with the search applied but not the state filter" }),
});

const switchSchema = z.object({
  enabled: z.boolean(),
  changedAt: z.iso.datetime().nullable(),
  changedBy: z.string().nullable(),
});

export const subscriptionViewSchema = z.object({
  subscription: subscriptionSchema,
  state: z.enum(["active", "ending", "ended", "stopped"]),
  services: z.object({
    subscriptionServing: z.boolean(),
    chatbot: z.boolean().meta({ description: "what runs now: its switch and the subscription" }),
    leads: z.boolean(),
    switches: z.object({ chatbot: switchSchema, leads: switchSchema }),
  }),
  heldLeads: z.number().meta({ description: "leads the hotel hasn't been told about yet" }),
  emailed: z.number().optional().meta({ description: "leads in the catch-up email this action sent" }),
});

export class SubscriptionResponseDto {
  static apps(apps: AppRecord[]): z.infer<typeof appListSchema> {
    return { apps };
  }

  static plans(plans: PlanRecord[]): z.infer<typeof planListSchema> {
    return { plans };
  }

  static page({ items, total, counts }: SubscriptionPage): z.infer<typeof subscriptionPageSchema> {
    return { items: items.map((s) => ({ ...SubscriptionResponseDto.subscription(s), state: s.state })), total, counts };
  }

  static view({
    subscription,
    state,
    services,
    heldLeads,
    emailed,
  }: SubscriptionView): z.infer<typeof subscriptionViewSchema> {
    const sw = (s: { enabled: boolean; changedAt: Date | null; changedBy: string | null }) => ({
      enabled: s.enabled,
      changedAt: s.changedAt?.toISOString() ?? null,
      changedBy: s.changedBy,
    });
    return {
      subscription: SubscriptionResponseDto.subscription(subscription),
      state,
      services: {
        subscriptionServing: services.subscriptionServing,
        chatbot: services.chatbot,
        leads: services.leads,
        switches: { chatbot: sw(services.switches.chatbot), leads: sw(services.switches.leads) },
      },
      heldLeads,
      ...(emailed ? { emailed } : {}),
    };
  }

  private static subscription(s: SubscriptionRecord): z.infer<typeof subscriptionSchema> {
    return {
      ndid: s.ndid,
      hotelName: s.hotelName,
      plan: s.plan,
      status: s.status,
      startDate: s.startDate.toISOString(),
      endDate: s.endDate.toISOString(),
      autoRenew: s.autoRenew,
      staffStop: s.staffStop
        ? {
            kind: s.staffStop.kind,
            at: s.staffStop.at.toISOString(),
            by: s.staffStop.by,
            reason: s.staffStop.reason,
            daysLeftWhenPaused:
              s.staffStop.remainingMs === null ? null : Math.round(s.staffStop.remainingMs / 86_400_000),
            appsEnded: s.staffStop.appsEnded === true,
          }
        : null,
      apps: s.apps.map((a) => ({
        appId: a.appId,
        name: a.name,
        code: a.code,
        isTrial: a.isTrial,
        startDate: a.startDate.toISOString(),
        endDate: a.endDate.toISOString(),
      })),
      appAccess: s.appAccess,
    };
  }
}
