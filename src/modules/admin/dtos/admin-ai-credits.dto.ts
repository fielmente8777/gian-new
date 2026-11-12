import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import { UtcDays } from "../../ai-credits/index.js";

const ndid = z.string().trim().min(1).max(64);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const credits = z.number().int("Credits are whole numbers").min(1).max(10_000_000);
const reason = z.string().trim().min(3, "Say why, in a few words").max(500);
/** the console makes one per click (crypto.randomUUID), so a retried request applies once */
const idempotencyKey = z
  .string()
  .trim()
  .regex(/^[\w:-]{8,100}$/, "Invalid request key");
const money = z.number().min(0).max(1_000_000);
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Use a 3-letter currency code");
const status = z.enum(["active", "inactive"]);
const atLeastOne = <T extends z.ZodObject>(schema: T) =>
  schema.refine((value) => Object.keys(value).length > 0, "Change at least one field");
const optionalSearch = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((value) => value || undefined);

// ── clients ─────────────────────────────────────────────────────────────────────────────

export class AiClientParamsDto extends BaseDto {
  static override readonly schema = z.object({ ndid });
}
export type AiClientParams = z.infer<typeof AiClientParamsDto.schema>;

export class AiClientListQueryDto extends BaseDto {
  static override readonly schema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    after: ndid.optional().meta({ description: "`nextCursor` from the previous page" }),
    search: optionalSearch.meta({ description: "part of the hotel name, domain or hotel email, or an exact ndid" }),
  });
}
export type AiClientListQuery = z.infer<typeof AiClientListQueryDto.schema>;

export class LedgerQueryDto extends BaseDto {
  static override readonly schema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    before: objectId.optional().meta({ description: "`nextCursor` from the previous page" }),
  });
}
export type LedgerQuery = z.infer<typeof LedgerQueryDto.schema>;

export class AdjustCreditsDto extends BaseDto {
  static override readonly schema = z.object({
    direction: z.enum(["add", "deduct"]),
    amount: credits,
    reason,
    idempotencyKey,
  });
}
export type AdjustCreditsBody = z.infer<typeof AdjustCreditsDto.schema>;

export class WalletStatusDto extends BaseDto {
  static override readonly schema = z.object({ status: z.enum(["active", "suspended"]), reason });
}
export type WalletStatusBody = z.infer<typeof WalletStatusDto.schema>;

export class BulkGrantDto extends BaseDto {
  static override readonly schema = z.object({
    ndids: z
      .array(ndid)
      .min(1)
      .max(200)
      .refine((list) => new Set(list).size === list.length, "A client is listed twice"),
    amount: credits,
    reason,
    batchId: idempotencyKey.meta({ description: "one per bulk action; each client's change uses `<batchId>:<ndid>`" }),
  });
}
export type BulkGrantBody = z.infer<typeof BulkGrantDto.schema>;

// ── pricing, packages, settings ─────────────────────────────────────────────────────────

export class IdParamsDto extends BaseDto {
  static override readonly schema = z.object({ id: objectId });
}
export type IdParams = z.infer<typeof IdParamsDto.schema>;

const pricingFields = {
  provider: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Invalid provider"),
  model: z
    .string()
    .trim()
    .regex(/^[\w.:/-]{1,100}$/, "Invalid model"),
  inputPrice: money.meta({ description: "per 1M input tokens, in `currency`" }),
  outputPrice: money.meta({ description: "per 1M output tokens" }),
  embeddingPrice: money.meta({ description: "per 1M embedding tokens" }),
  requestPrice: money.meta({ description: "per call, for APIs not billed by tokens (speech-to-text)" }),
  currency,
  creditConversionRate: z
    .number()
    .positive()
    .max(10_000_000)
    .meta({ description: "credits charged per 1 unit of provider cost; carries the margin" }),
  status,
};

export class CreatePricingDto extends BaseDto {
  static override readonly schema = z.object({
    ...pricingFields,
    inputPrice: pricingFields.inputPrice.default(0),
    outputPrice: pricingFields.outputPrice.default(0),
    embeddingPrice: pricingFields.embeddingPrice.default(0),
    requestPrice: pricingFields.requestPrice.default(0),
    currency: currency.default("USD"),
    status: status.default("active"),
  });
}
export type CreatePricingBody = z.infer<typeof CreatePricingDto.schema>;

export class UpdatePricingDto extends BaseDto {
  static override readonly schema = atLeastOne(z.object(pricingFields).partial());
}
export type UpdatePricingBody = z.infer<typeof UpdatePricingDto.schema>;

const packageFields = {
  name: z.string().trim().min(1).max(60),
  credits,
  price: z
    .number()
    .min(1)
    .max(10_000_000)
    .meta({ description: "what the hotel pays, in `currency` (₹), GST included" }),
  currency,
  status,
  popular: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
};

export class CreatePackageDto extends BaseDto {
  static override readonly schema = z.object({
    ...packageFields,
    currency: currency.default("INR"),
    status: status.default("active"),
    popular: z.boolean().default(false),
    sortOrder: packageFields.sortOrder.default(0),
  });
}
export type CreatePackageBody = z.infer<typeof CreatePackageDto.schema>;

export class UpdatePackageDto extends BaseDto {
  static override readonly schema = atLeastOne(z.object(packageFields).partial());
}
export type UpdatePackageBody = z.infer<typeof UpdatePackageDto.schema>;

export class AiSettingsDto extends BaseDto {
  static override readonly schema = z
    .object({
      credits: z
        .object({
          enabled: z.boolean().meta({ description: "Charge AI credits at all. Off: AI is free and never blocked" }),
          lowThreshold: z.number().int().min(0).max(10_000_000),
          criticalThreshold: z.number().int().min(0).max(10_000_000),
          chatReserveCredits: z.number().int().min(1).max(100_000),
          reserveMultiplier: z.number().min(1).max(10),
          reservationTtlMinutes: z.number().int().min(5).max(1440),
          fallbackCreditsPer1kTokens: z.number().min(0).max(100_000),
          fallbackCreditsPerRequest: z.number().min(0).max(100_000),
        })
        .partial()
        .optional()
        .meta({ description: "gian's credit settings: on/off, low-balance levels, holds, rates for unpriced models" }),
      pool: z
        .object({
          lowPoolUsd: z.number().min(0).max(1_000_000),
          lowRunwayDays: z.number().min(0).max(365),
          alertEmails: z.array(z.string().trim().toLowerCase().pipe(z.email())).max(20),
          usdInrRate: z.number().positive().max(1000).nullable(),
        })
        .partial()
        .optional()
        .meta({ description: "OpenAI pool alerts and the USD→INR rate used for display" }),
    })
    .refine(
      (v) => Object.keys(v.credits ?? {}).length + Object.keys(v.pool ?? {}).length > 0,
      "Change at least one setting",
    );
}
export type AiSettingsBody = z.infer<typeof AiSettingsDto.schema>;

// ── the OpenAI account ──────────────────────────────────────────────────────────────────

const paidOn = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((v) => UtcDays.isDate(v), "Not a real date");
const topUpFields = {
  amountUsd: z.number().positive().max(1_000_000),
  paidOn: paidOn.meta({ description: "the day the money reached OpenAI (UTC)" }),
  note: z
    .string()
    .trim()
    .max(300)
    .transform((v) => v || null)
    .nullable(),
};

export class CreateTopUpDto extends BaseDto {
  static override readonly schema = z.object({ ...topUpFields, note: topUpFields.note.default(null) });
}
export type CreateTopUpBody = z.infer<typeof CreateTopUpDto.schema>;

export class UpdateTopUpDto extends BaseDto {
  static override readonly schema = atLeastOne(z.object(topUpFields).partial());
}
export type UpdateTopUpBody = z.infer<typeof UpdateTopUpDto.schema>;

export class CostsQueryDto extends BaseDto {
  static override readonly schema = z.object({ days: z.coerce.number().int().min(7).max(180).default(30) });
}
export type CostsQuery = z.infer<typeof CostsQueryDto.schema>;

export class AiAuditQueryDto extends BaseDto {
  static override readonly schema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: objectId.optional(),
    ndid: ndid.optional().meta({ description: "only this client's entries" }),
  });
}
export type AiAuditQuery = z.infer<typeof AiAuditQueryDto.schema>;

const loose = (description: string) => z.looseObject({}).meta({ description });
export const aiOverviewSchema = loose(
  "openai (pool, spend, runway, lastSync), credits (wallet totals), coverage, alerts, lowWallets",
);
export const aiClientPageSchema = loose("items (ndid, hotelName, wallet, level), nextCursor");
export const aiClientSchema = loose("client, wallet, level, usage (last 30 days by service and model)");
export const ledgerPageSchema = loose(
  "items (type, amount, balanceBefore/After, description, performedBy), nextCursor",
);
export const adjustmentSchema = loose("transactionId, balanceBefore, balanceAfter, replayed");
export const bulkGrantSchema = loose("results per client (ok, balanceAfter or error code), granted, failed");
export const pricingListSchema = loose(
  "items (with costPerCreditUsd / costPerCreditInr / margin), appliesWithinSeconds",
);
export const pricingRowSchema = loose("the pricing row, appliesWithinSeconds");
export const packageListSchema = loose("packages");
export const aiSettingsSchema = loose("credits (gian's settings), pool (alerts and USD→INR rate)");
export const topUpListSchema = loose("items, totalUsd");
export const topUpSchema = loose("the top-up");
export const reconciliationSchema = loose("days (openaiUsd, trackedUsd, billedUsd, gapUsd), totals, lineItems");
export const syncStatusSchema = loose("at, ok, from, to, rows, error");
export const aiAuditPageSchema = loose("items from gian's aiadminauditlogs, nextCursor");
