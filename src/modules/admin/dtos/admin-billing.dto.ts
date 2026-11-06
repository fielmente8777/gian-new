import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const limit = z.number().int().min(-1).max(1_000_000).meta({ description: "-1 = unlimited" });
const rupees = z.number().min(0).max(10_000_000);
const text = (max: number) => z.string().trim().max(max);
const appCode = z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "lower case letters, digits and _");
const ndid = z.string().trim().min(1).max(64);
const date = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

// ─── plans ───────────────────────────────────────────────────────────────────────────

const planFields = {
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/, "letters, digits and _, e.g. PRO or GROWTH_PLUS"))
    .meta({ description: "stored as planName; BASIC, PRO, ENTERPRISE or a new one" }),
  name: text(60).min(1),
  tagline: text(200).default(""),
  price: rupees.meta({ description: "per month in rupees, before GST; 0 with isCustom = contact sales" }),
  includedApps: z.array(appCode).max(50).default([]),
  highlights: z.array(text(120).min(1)).max(20).default([]),
  limits: z.object({ teamMembers: limit, properties: limit, aiCreditsMonthly: limit, maxLeadsPerMonth: limit }),
  support: z.enum(["none", "standard", "premium", "enterprise"]).default("standard"),
  isPublic: z.boolean().default(true),
  isCustom: z.boolean().default(false),
  customPriceLabel: text(30).default("").meta({ description: "custom plans: shown instead of a price; empty = Let's talk" }),
  customPriceNote: text(80).default("").meta({ description: "custom plans: the line under it" }),
  customCtaLabel: text(30).default("").meta({ description: "custom plans: the button; empty = Talk to sales" }),
  visibleTo: z.array(ndid).max(500).default([]).meta({ description: "hotels that can also see and buy it (private offer)" }),
  isActive: z.boolean().default(true),
  featured: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
};

export class CreatePlanDto extends BaseDto {
  static override readonly schema = z.object(planFields);
}
export type CreatePlanBody = z.infer<typeof CreatePlanDto.schema>;

export class UpdatePlanDto extends BaseDto {
  static override readonly schema = z
    .object({
      code: planFields.code.optional(),
      name: planFields.name.optional(),
      tagline: text(200).optional(),
      price: rupees.optional(),
      includedApps: z.array(appCode).max(50).optional(),
      highlights: z.array(text(120).min(1)).max(20).optional(),
      limits: planFields.limits.optional(),
      support: z.enum(["none", "standard", "premium", "enterprise"]).optional(),
      isPublic: z.boolean().optional(),
      isCustom: z.boolean().optional(),
      customPriceLabel: text(30).optional(),
      customPriceNote: text(80).optional(),
      customCtaLabel: text(30).optional(),
      visibleTo: z.array(ndid).max(500).optional(),
      isActive: z.boolean().optional(),
      featured: z.boolean().optional(),
      sortOrder: z.number().int().min(0).max(10_000).optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { error: "Nothing to change" });
}
export type UpdatePlanBody = z.infer<typeof UpdatePlanDto.schema>;

// ─── apps ────────────────────────────────────────────────────────────────────────────

export class CreateAppDto extends BaseDto {
  static override readonly schema = z.object({
    code: appCode.meta({ description: "the dashboard's appAccess key; never changes later" }),
    name: text(60).min(1),
    description: text(300).default(""),
    price: rupees.meta({ description: "per month in rupees, before GST" }),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(10_000).default(100),
  });
}
export type CreateAppBody = z.infer<typeof CreateAppDto.schema>;

export class UpdateAppDto extends BaseDto {
  static override readonly schema = z
    .object({
      name: text(60).min(1).optional(),
      description: text(300).optional(),
      price: rupees.optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.number().int().min(0).max(10_000).optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { error: "Nothing to change" });
}
export type UpdateAppBody = z.infer<typeof UpdateAppDto.schema>;

// ─── settings ────────────────────────────────────────────────────────────────────────

export class BillingSettingsDto extends BaseDto {
  static override readonly schema = z
    .object({
      currency: z.literal("INR").default("INR"),
      gstPercent: z.number().min(0).max(50),
      seatPrice: rupees.meta({ description: "per extra team member per month" }),
      trialDays: z.number().int().min(0).max(90),
      invoice: z
        .object({
          name: text(120).min(1),
          address: text(400),
          state: text(60),
          gstin: z
            .string()
            .trim()
            .toUpperCase()
            .refine((v) => v === "" || /^[0-9]{2}[A-Z0-9]{13}$/.test(v), "A GSTIN has 15 characters, starting with the state code"),
          pan: z.string().trim().toUpperCase().max(10),
          email: z.union([z.literal(""), z.email()]),
          phone: text(30),
          sac: text(10),
          prefix: z.string().trim().regex(/^[A-Z0-9-]{1,10}$/, "Up to 10 letters, digits or -"),
        })
        .partial()
        .optional()
        .meta({ description: "Eazotel's details printed on invoices; fields left out keep their value" }),
      cycles: z
        .array(
          z.object({
            months: z.number().int().min(1).max(36),
            label: text(30).min(1),
            discountPercent: z.number().min(0).max(90),
            isActive: z.boolean().default(true),
          }),
        )
        .min(1)
        .max(8),
    })
    .refine((s) => new Set(s.cycles.map((c) => c.months)).size === s.cycles.length, {
      error: "Each cycle needs a different number of months",
      path: ["cycles"],
    })
    .refine((s) => s.cycles.some((c) => c.isActive), { error: "Keep at least one cycle on", path: ["cycles"] });
}
export type BillingSettingsBody = z.infer<typeof BillingSettingsDto.schema>;

// ─── offers ──────────────────────────────────────────────────────────────────────────

const offerFields = {
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9_-]{3,30}$/, "3-30 letters, digits, - or _")),
  name: text(80).min(1),
  description: text(300).default(""),
  type: z.enum(["percent", "flat"]),
  value: z.number().positive().max(10_000_000).meta({ description: "percent (1-100) or rupees" }),
  maxDiscount: rupees.nullable().default(null).meta({ description: "cap for percent offers, rupees" }),
  planCodes: z.array(z.string().trim().toUpperCase()).max(20).default([]),
  cycleMonths: z.array(z.number().int().min(1).max(36)).max(8).default([]),
  kinds: z.array(z.enum(["new", "renew", "change"])).max(3).default([]),
  firstPurchaseOnly: z.boolean().default(false),
  ndids: z.array(ndid).max(500).default([]).meta({ description: "empty = everyone; else a private code" }),
  startsAt: date.nullable().default(null),
  endsAt: date.nullable().default(null),
  maxRedemptions: z.number().int().min(1).nullable().default(null),
  perClientLimit: z.number().int().min(1).nullable().default(1),
  isActive: z.boolean().default(true),
  showOnPricing: z.boolean().default(false),
};

const offerRules = <T extends { type?: string; value?: number; startsAt?: Date | null; endsAt?: Date | null }>(s: z.ZodType<T>) =>
  s
    .refine((o) => o.type !== "percent" || (o.value ?? 0) <= 100, { error: "A percent offer is at most 100", path: ["value"] })
    .refine((o) => !o.startsAt || !o.endsAt || o.endsAt > o.startsAt, { error: "The end must be after the start", path: ["endsAt"] });

export class CreateOfferDto extends BaseDto {
  static override readonly schema = offerRules(z.object(offerFields));
}
export type CreateOfferBody = z.infer<typeof CreateOfferDto.schema>;

export class UpdateOfferDto extends BaseDto {
  static override readonly schema = offerRules(
    z.object({
      code: offerFields.code.optional(),
      name: text(80).min(1).optional(),
      description: text(300).optional(),
      type: z.enum(["percent", "flat"]).optional(),
      value: z.number().positive().max(10_000_000).optional(),
      maxDiscount: rupees.nullable().optional(),
      planCodes: z.array(z.string().trim().toUpperCase()).max(20).optional(),
      cycleMonths: z.array(z.number().int().min(1).max(36)).max(8).optional(),
      kinds: z.array(z.enum(["new", "renew", "change"])).max(3).optional(),
      firstPurchaseOnly: z.boolean().optional(),
      ndids: z.array(ndid).max(500).optional(),
      startsAt: date.nullable().optional(),
      endsAt: date.nullable().optional(),
      maxRedemptions: z.number().int().min(1).nullable().optional(),
      perClientLimit: z.number().int().min(1).nullable().optional(),
      isActive: z.boolean().optional(),
      showOnPricing: z.boolean().optional(),
    }),
  );
}
export type UpdateOfferBody = z.infer<typeof UpdateOfferDto.schema>;

// ─── invoices ────────────────────────────────────────────────────────────────────────

export class EmailInvoiceDto extends BaseDto {
  static override readonly schema = z.object({
    to: z
      .array(z.email())
      .max(5)
      .default([])
      .meta({ description: "addresses to send to; empty = the hotel's invoice email, hotel email and owner" }),
  });
}
export type EmailInvoiceBody = z.infer<typeof EmailInvoiceDto.schema>;

export class OrderParamsDto extends BaseDto {
  static override readonly schema = z.object({ orderId: z.string().trim().min(1).max(100) });
}
export type OrderParams = z.infer<typeof OrderParamsDto.schema>;

// ─── params and queries ─────────────────────────────────────────────────────────────

export class IdParamsDto extends BaseDto {
  static override readonly schema = z.object({ id: objectId });
}
export type IdParams = z.infer<typeof IdParamsDto.schema>;

export class PaymentListQueryDto extends BaseDto {
  static override readonly schema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(5).max(100).default(25),
    status: z.enum(["created", "SUCCESS", "FAILED"]).optional(),
    ndid: ndid.optional(),
    source: z.enum(["gian-new", "gian"]).optional(),
    from: z.iso.date().optional().meta({ description: "first day, India time" }),
    to: z.iso.date().optional().meta({ description: "last day, India time" }),
  });
}
export type PaymentListQueryParams = z.infer<typeof PaymentListQueryDto.schema>;

const loose = (description: string) => z.looseObject({}).meta({ description });
export const billingOverviewSchema = loose("revenue (paise) and subscription counts");
export const adminCatalogueSchema = loose("every plan (archived too), app, the settings and every offer");
export const paymentPageSchema = loose("items (with hotelName, planCode) and total");
export const catalogueItemSchema = loose("the saved plan, app, settings or offer");
export const invoiceSummarySchema = loose("id, number, ndid, buyerName, totalPaise, issuedAt, emailedTo, suggestedRecipients");
