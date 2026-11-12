import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";

const ndid = z.string().trim().min(1).max(64);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export class TeamMemberParamsDto extends BaseDto {
  static override readonly schema = z.object({ ndid, userId: objectId });
}
export type TeamMemberParams = z.infer<typeof TeamMemberParamsDto.schema>;

/**
 * Saved as "+<country code><number>", how onboarding writes the hotel phone. Spaces, dashes
 * and brackets are dropped; a 10-digit number is taken as Indian (+91). Empty clears it.
 */
const teamPhone = z
  .string()
  .transform((value) => value.replace(/[\s\-().‎‪-‮]/g, ""))
  .transform((value) => (value.startsWith("00") ? `+${value.slice(2)}` : value))
  .pipe(
    z
      .string()
      .regex(/^(\+?\d{10,15})?$/, "Enter a phone number with its country code, e.g. +91 98765 43210"),
  )
  .transform((value) => {
    if (value === "") return null;
    const digits = value.replace(/\D/g, "");
    if (value.startsWith("+")) return `+${digits}`;
    return digits.length === 10 ? `+91${digits}` : `+${digits}`;
  });

export class SetTeamPhoneDto extends BaseDto {
  static override readonly schema = z.object({
    phone: teamPhone.nullable().transform((value) => value ?? null),
    addToAlerts: z
      .boolean()
      .default(false)
      .meta({ description: "also put the number on every lead source's WhatsApp list of the visible properties" }),
  });
}
export type SetTeamPhoneBody = z.infer<typeof SetTeamPhoneDto.schema>;

export class FixOwnerPhonesDto extends BaseDto {
  static override readonly schema = z.object({
    ndids: z.array(ndid).min(1, "Pick at least one client").max(100, "At most 100 clients at a time"),
  });
}
export type FixOwnerPhonesBody = z.infer<typeof FixOwnerPhonesDto.schema>;

// ── responses ───────────────────────────────────────────────────────────────

const alertCoverage = z.enum(["hotel_phone", "all", "some", "none"]).nullable().meta({
  description:
    "hotel_phone: it is the hotel's phone (always alerted); all / some / none: on every, some or no WhatsApp " +
    "list of the visible properties; null: no phone",
});

export const clientTeamSchema = z.object({
  ndid: z.string(),
  hotelName: z.string().nullable(),
  hotelPhone: z.string().nullable(),
  suggestedOwnerPhone: z
    .string()
    .nullable()
    .meta({ description: "the hotel phone ready to copy to the owner; null when it has no country code" }),
  members: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string(),
      role: z.string().nullable(),
      isOwner: z.boolean().meta({ description: "the account holder (the oldest admin)" }),
      isAdmin: z.boolean(),
      isActive: z.boolean(),
      phone: z.string().nullable(),
      alerts: alertCoverage,
    }),
  ),
});

export const ownersMissingPhoneSchema = z.object({
  items: z.array(
    z.object({
      ndid: z.string(),
      hotelName: z.string().nullable(),
      ownerId: z.string(),
      ownerEmail: z.string(),
      ownerName: z.string().nullable(),
      hotelPhone: z.string().nullable(),
      suggestedPhone: z
        .string()
        .nullable()
        .meta({ description: "what Fix saves; null = the hotel phone is missing or has no country code" }),
    }),
  ),
});

export const fixOwnerPhonesSchema = z.object({
  results: z.array(
    z.object({
      ndid: z.string(),
      hotelName: z.string().nullable(),
      outcome: z.enum(["fixed", "has_phone", "no_hotel_phone", "not_found"]),
      ownerEmail: z.string().nullable(),
      phone: z.string().nullable(),
      alertsAdded: z.number().int(),
    }),
  ),
});
