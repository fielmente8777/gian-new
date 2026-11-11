import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";

const ndid = z.string().trim().min(1).max(64);
const id = z.string().trim().min(1).max(64);

export class ZohoNdidParamsDto extends BaseDto {
  static override readonly schema = z.object({ ndid });
}
export class ZohoInvoiceParamsDto extends BaseDto {
  static override readonly schema = z.object({ invoiceId: id });
}

export class ZohoProviderDto extends BaseDto {
  static override readonly schema = z.object({
    provider: z.enum(["razorpay", "zoho"]).meta({
      description:
        "razorpay: hotels pay in the dashboard (default). zoho: the pay button makes a Zoho Books invoice to pay.",
    }),
  });
}

export class ZohoTaxDto extends BaseDto {
  static override readonly schema = z.object({
    taxId: id.nullable().meta({ description: "a tax id from /taxes; null = no tax line" }),
  });
}

export class ZohoLinkDto extends BaseDto {
  static override readonly schema = z.object({ contactId: id });
}

export class ZohoInvoiceStateQueryDto extends BaseDto {
  static override readonly schema = z.object({
    state: z.enum(["review", "applied", "open", "all"]).default("review").meta({
      description: "review: paid in Zoho, waiting for staff. applied: renewed a plan. open: not paid yet.",
    }),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  });
}

const choice = {
  planId: z.string().regex(/^[a-f\d]{24}$/i, "Pick a plan"),
  cycleMonths: z.number().int().min(1).max(60),
  addonCodes: z.array(z.string().trim().min(1).max(64)).max(30).default([]),
  seats: z.number().int().min(0).max(500).default(0),
};

export class ZohoApplyDto extends BaseDto {
  static override readonly schema = z.object({ ndid, ...choice });
}
export type ZohoApplyBody = z.infer<typeof ZohoApplyDto.schema>;

export class ZohoCreateInvoiceDto extends BaseDto {
  static override readonly schema = z.object({
    ...choice,
    offerCode: z.string().trim().max(40).nullable().optional(),
    emailTo: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .pipe(z.email({ error: "Enter valid email addresses" })),
      )
      .max(5)
      .default([])
      .meta({ description: "Zoho emails the invoice here; empty = staff share the link themselves" }),
  });
}
export type ZohoCreateInvoiceBody = z.infer<typeof ZohoCreateInvoiceDto.schema>;

/** Responses are documented loosely: the admin console is the only reader. */
const loose = (description: string) => z.record(z.string(), z.unknown()).meta({ description });
export const zohoStatusSchema = loose(
  "configured, connected, orgName, taxName, lastSyncAt, redirectUri, webhookReady, payment { provider }",
);
export const zohoListSchema = loose("items");
export const zohoItemSchema = loose("the changed row");
