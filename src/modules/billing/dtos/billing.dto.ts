import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const appCode = z.string().trim().min(1).max(60);

const choice = {
  planId: objectId.meta({ description: "the plan's id from the catalogue" }),
  cycleMonths: z.number().int().min(1).max(36).meta({ description: "one of the catalogue's cycles, e.g. 12" }),
  addonCodes: z
    .array(appCode)
    .max(50)
    .default([])
    .meta({ description: "add-on app codes; ones the plan already includes are ignored" }),
  seats: z.number().int().min(0).max(200).default(0).meta({ description: "extra team members beyond the plan's" }),
  offerCode: z.string().trim().max(40).nullable().optional().meta({ description: "a discount code, if any" }),
};

export class PurchaseChoiceDto extends BaseDto {
  static override readonly schema = z.object(choice);
}
export type PurchaseChoiceBody = z.infer<typeof PurchaseChoiceDto.schema>;

export class CheckoutDto extends BaseDto {
  static override readonly schema = z.object({
    ...choice,
    autoRenew: z.boolean().default(false).meta({ description: "set up auto-renew after this payment" }),
    expectedTotalPaise: z
      .number()
      .int()
      .min(0)
      .optional()
      .meta({ description: "the total the hotel saw; if the server's differs it answers 409 PRICE_CHANGED" }),
  });
}
export type CheckoutBody = z.infer<typeof CheckoutDto.schema>;

/** Razorpay checkout's handler result, as Razorpay names it. */
export class ConfirmPaymentDto extends BaseDto {
  static override readonly schema = z.object({
    razorpay_order_id: z.string().min(1).max(100),
    razorpay_payment_id: z.string().min(1).max(100),
    razorpay_signature: z.string().min(1).max(200),
  });
}
export type ConfirmPaymentBody = z.infer<typeof ConfirmPaymentDto.schema>;

export class AutoRenewDto extends BaseDto {
  static override readonly schema = z.object({ enabled: z.boolean() });
}
export type AutoRenewBody = z.infer<typeof AutoRenewDto.schema>;

export class ConfirmAutoRenewDto extends BaseDto {
  static override readonly schema = z.object({
    razorpay_subscription_id: z.string().min(1).max(100),
    razorpay_payment_id: z.string().min(1).max(100),
    razorpay_signature: z.string().min(1).max(200),
  });
}
export type ConfirmAutoRenewBody = z.infer<typeof ConfirmAutoRenewDto.schema>;

export class InvoiceParamsDto extends BaseDto {
  static override readonly schema = z.object({ id: objectId });
}
export type InvoiceParams = z.infer<typeof InvoiceParamsDto.schema>;

/** What the hotel wants on its invoices. GSTIN optional (15 characters when given). */
export class BillingDetailsDto extends BaseDto {
  static override readonly schema = z.object({
    legalName: z.string().trim().min(1).max(160),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .refine((v) => v === "" || /^[0-9]{2}[A-Z0-9]{13}$/.test(v), "A GSTIN has 15 characters, starting with the state code")
      .default(""),
    address: z.string().trim().max(400).default(""),
    city: z.string().trim().max(80).default(""),
    state: z.string().trim().max(60).default(""),
    pinCode: z.string().trim().max(12).default(""),
    email: z.union([z.literal(""), z.email()]).default(""),
  });
}
export type BillingDetailsBody = z.infer<typeof BillingDetailsDto.schema>;

// Response shapes, for /docs. Amounts are paise; dates ISO strings.
const loose = (description: string) => z.looseObject({}).meta({ description });
export const catalogueSchema = loose("plans, apps, settings (cycles, GST, seat price) and featured offers");
export const accountSchema = loose("phase, subscription, current terms, entitlements, catalogue, payments");
export const quoteSchema = loose("kind, lines, discounts, credit, GST, total and the new period (amounts in paise)");
export const checkoutSchema = loose("status pending + Razorpay order details, or status applied + account");
export const autoRenewSchema = loose("Razorpay subscription id and key id to open checkout, or the account");
export const billingDetailsSchema = loose("legalName, gstin, address, city, state, pinCode, email");
