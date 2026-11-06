import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import type { ProfilePage, ProfileRecord } from "../../profiles/index.js";
import { CLIENT_SERVICES } from "../../client-services/index.js";
import { LEAD_SOURCES, type LeadSource } from "../../hotel-notifications/index.js";
import type { ClientServicesView, ClientView, OpenedAccount } from "../services/admin-clients.service.js";

const ndid = z.string().trim().min(1).max(64);

export class ClientListQueryDto extends BaseDto {
  static override readonly schema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    after: ndid.optional().meta({ description: "`nextCursor` from the previous page" }),
    search: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((value) => value || undefined)
      .meta({ description: "part of the hotel name, domain or hotel email, or an exact ndid" }),
  });
}
export type ClientListQuery = z.infer<typeof ClientListQueryDto.schema>;

export class ClientParamsDto extends BaseDto {
  static override readonly schema = z.object({ ndid });
}
export type ClientParams = z.infer<typeof ClientParamsDto.schema>;

/** Empty text clears a field. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable()
    .optional();

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((value) => value === "" || z.email().safeParse(value).success, "Enter a valid email address")
  .transform((value) => value || null)
  .nullable()
  .optional();

const propertyChanges = z.object({
  name: optionalText(120),
  city: optionalText(80),
  state: optionalText(80),
  country: optionalText(80),
  pinCode: optionalText(20),
});

export class UpdateClientDto extends BaseDto {
  static override readonly schema = z
    .object({
      hotelDescription: optionalText(2000),
      hotelEmail: optionalEmail,
      hotelPhone: optionalText(30),
      marketingEmail: optionalEmail,
      properties: z
        .record(z.string().regex(/^[\w-]{1,64}$/, "Invalid property id"), propertyChanges)
        .optional()
        .meta({ description: "changes per property, keyed by hid" }),
    })
    .refine((body) => Object.keys(body).length > 0, { error: "Send at least one field to change" });
}
export type UpdateClientBody = z.infer<typeof UpdateClientDto.schema>;

// ── responses ───────────────────────────────────────────────────────────────

const propertySchema = z.object({
  hid: z.string(),
  name: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  pinCode: z.string().nullable(),
});

const clientSummarySchema = z.object({
  ndid: z.string(),
  hotelName: z.string().nullable(),
  domain: z.string().nullable(),
  hotelEmail: z.string().nullable(),
  planName: z.string().nullable(),
  planExpiry: z.string().nullable().meta({ description: "as recorded on the profile, yy-mm-dd" }),
  properties: z.array(propertySchema).meta({ description: "for an admin, only the properties assigned to them" }),
});

export const clientPageSchema = z.object({
  items: z.array(clientSummarySchema),
  nextCursor: z.string().nullable(),
});

export const clientSchema = z.object({
  ndid: z.string(),
  hotelName: z.string().nullable(),
  hotelDescription: z.string().nullable(),
  hotelEmail: z.string().nullable(),
  hotelPhone: z.string().nullable(),
  marketingEmail: z.string().nullable(),
  domain: z.string().nullable(),
  currency: z.string().nullable(),
  isVerified: z.boolean(),
  plan: z
    .object({ name: z.string().nullable(), activationDate: z.string().nullable(), expiryDate: z.string().nullable() })
    .nullable(),
  onboardedAt: z.iso.datetime().nullable(),
  properties: z.array(propertySchema),
  owner: z
    .object({ email: z.string(), name: z.string().nullable(), phone: z.string().nullable(), isActive: z.boolean() })
    .nullable()
    .meta({ description: "who holds the hotel's dashboard account" }),
});

export const openedAccountSchema = z.object({
  token: z
    .string()
    .meta({ description: "nexon-style token for the hotel dashboard. Never store it beyond the handoff" }),
  expiresAt: z.iso.datetime(),
  ndid: z.string(),
  hid: z.string().nullable().meta({ description: "property to open on: the first one this person may see" }),
  accountEmail: z.string(),
});

export class ClientServiceParamsDto extends BaseDto {
  static override readonly schema = z.object({ ndid, service: z.enum(CLIENT_SERVICES) });
}
export type ClientServiceParams = z.infer<typeof ClientServiceParamsDto.schema>;

export class SetClientServiceDto extends BaseDto {
  static override readonly schema = z.object({ enabled: z.boolean() });
}
export type SetClientServiceBody = z.infer<typeof SetClientServiceDto.schema>;

const serviceStateSchema = z.object({
  enabled: z.boolean(),
  changedAt: z.iso.datetime().nullable(),
  changedBy: z.string().nullable(),
});

export const clientServicesSchema = z.object({
  switches: z.object(Object.fromEntries(CLIENT_SERVICES.map((s) => [s, serviceStateSchema]))),
  subscriptionServing: z
    .boolean()
    .meta({ description: "false while staff have paused or expired the subscription: every service is off" }),
  chatbot: z.boolean().meta({ description: "what runs now: the switch and the subscription" }),
  leads: z.boolean(),
  heldLeads: z.number().meta({ description: "leads the hotel hasn't been told about yet" }),
  released: z
    .object({ leads: z.number(), contacts: z.number() })
    .optional()
    .meta({ description: "after leads could be delivered again: what moved back into the dashboard" }),
  emailed: z.number().optional().meta({ description: "leads in the catch-up email just sent" }),
});

// ── lead alerts (hotelnotifications) ────────────────────────────────────────

export class ClientPropertyParamsDto extends BaseDto {
  static override readonly schema = z.object({ ndid, hid: z.string().regex(/^[\w-]{1,64}$/, "Invalid property id") });
}
export type ClientPropertyParams = z.infer<typeof ClientPropertyParamsDto.schema>;

const alertEmail = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address"));
/**
 * Saved as gian sends it: digits with the country code. Spaces, dashes and a leading + are
 * dropped; a 10-digit number is taken as Indian (91 in front).
 */
const alertPhone = z
  .string()
  .transform((value) => value.replace(/[\s\-().+‎‪-‮]/g, ""))
  .pipe(z.string().regex(/^\d{10,15}$/, "Enter a phone number with its country code, e.g. +91 98765 43210"))
  .transform((digits) => (digits.length === 10 ? `91${digits}` : digits));
const unique = <T extends z.ZodType<string>>(item: T) =>
  z
    .array(item)
    .max(10, "At most 10")
    .transform((list) => [...new Set(list)]);

const sourceAlertsInput = z.object({
  email: z.boolean(),
  emails: unique(alertEmail).meta({ description: "besides the hotel's own email" }),
  whatsapp: z.boolean(),
  phones: unique(alertPhone).meta({ description: "besides the hotel's own phone" }),
});

export class SaveNotificationsDto extends BaseDto {
  static override readonly schema = z.object({
    sources: z.object(
      Object.fromEntries(LEAD_SOURCES.map((s) => [s, sourceAlertsInput])) as {
        [K in LeadSource]: typeof sourceAlertsInput;
      },
    ),
  });
}
export type SaveNotificationsBody = z.infer<typeof SaveNotificationsDto.schema>;

const sourceAlertsSchema = z.object({
  email: z.boolean(),
  emails: z.array(z.string()),
  whatsapp: z.boolean(),
  phones: z.array(z.string()),
});

const propertyAlertsSchema = z.object({
  hid: z.string(),
  name: z.string().nullable(),
  saved: z.boolean().meta({ description: "false: never saved, gian's defaults apply (no email, WhatsApp on)" }),
  sources: z.object(Object.fromEntries(LEAD_SOURCES.map((s) => [s, sourceAlertsSchema]))),
});

export const clientNotificationsSchema = z.object({
  hotelEmail: z.string().nullable().meta({ description: "always gets the email alerts that are on" }),
  hotelPhone: z.string().nullable().meta({ description: "always gets the WhatsApp alerts that are on" }),
  leadsDelivered: z
    .boolean()
    .meta({ description: "false while the Leads switch is off or the subscription is stopped: no alert goes out" }),
  subscriptionServing: z.boolean(),
  properties: z.array(propertyAlertsSchema).meta({ description: "only the properties this person may see" }),
});

export class DeleteClientDto extends BaseDto {
  static override readonly schema = z.object({
    confirmName: z.string().trim().min(1, "Type the hotel's name to confirm").max(200),
    reason: z
      .string()
      .trim()
      .max(500)
      .transform((v) => v || null)
      .nullable()
      .optional(),
  });
}
export type DeleteClientBody = z.infer<typeof DeleteClientDto.schema>;

const collectionCountsSchema = z.array(z.object({ collection: z.string(), count: z.number() }));

export const deletionPreviewSchema = z.object({
  ndid: z.string(),
  hotelName: z.string().nullable(),
  collections: collectionCountsSchema.meta({ description: "collections with records of this client, most first" }),
  total: z.number(),
});

export const deletionResultSchema = z.object({
  ndid: z.string(),
  deletionId: z.string().meta({ description: "finds the archived copies in deleted_client_records" }),
  collections: collectionCountsSchema,
  total: z.number(),
});

export class ClientResponseDto {
  static page({ items, nextCursor }: ProfilePage): z.infer<typeof clientPageSchema> {
    return { items: items.map((profile) => ClientResponseDto.summary(profile)), nextCursor };
  }

  static client({ profile, owner }: ClientView): z.infer<typeof clientSchema> {
    return { ...profile, owner };
  }

  static opened({ token, expiresAt, ndid, hid, accountEmail }: OpenedAccount): z.infer<typeof openedAccountSchema> {
    return { token, expiresAt: expiresAt.toISOString(), ndid, hid, accountEmail };
  }

  static services(view: ClientServicesView): z.infer<typeof clientServicesSchema> {
    return {
      switches: Object.fromEntries(
        Object.entries(view.switches).map(([name, s]) => [
          name,
          { enabled: s.enabled, changedAt: s.changedAt?.toISOString() ?? null, changedBy: s.changedBy },
        ]),
      ),
      subscriptionServing: view.subscriptionServing,
      chatbot: view.chatbot,
      leads: view.leads,
      heldLeads: view.heldLeads,
      ...(view.released ? { released: view.released } : {}),
      ...(view.emailed ? { emailed: view.emailed } : {}),
    };
  }

  private static summary(profile: ProfileRecord): z.infer<typeof clientSummarySchema> {
    return {
      ndid: profile.ndid,
      hotelName: profile.hotelName,
      domain: profile.domain,
      hotelEmail: profile.hotelEmail,
      planName: profile.plan?.name ?? null,
      planExpiry: profile.plan?.expiryDate ?? null,
      properties: profile.properties,
    };
  }
}
