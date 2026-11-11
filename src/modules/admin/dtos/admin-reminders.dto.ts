import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import type { ChannelResult, ReminderLogEntry, UpcomingReminder } from "../../renewal-reminders/index.js";
import type { RemindersOverview } from "../services/admin-reminders.service.js";

const dayList = z
  .array(z.number().int().min(1).max(60))
  .max(10, "At most 10 days")
  .meta({ description: "whole days, e.g. [7, 3, 1]" });

export class ReminderSettingsDto extends BaseDto {
  static override readonly schema = z.object({
    enabled: z.boolean(),
    daysBefore: dayList,
    onEndDay: z.boolean(),
    daysAfter: dayList,
    channels: z.object({ email: z.boolean(), whatsapp: z.boolean() }),
    whatsappTemplate: z.object({
      name: z
        .string()
        .trim()
        .regex(/^[a-z0-9_]{1,512}$/, "Template names are lower case letters, digits and _"),
      language: z.string().trim().min(2).max(10).meta({ example: "en" }),
    }),
    includeTrial: z.boolean(),
    sendHourIst: z.number().int().min(0).max(23),
    renewUrl: z
      .string()
      .trim()
      .max(500)
      .refine((v) => v === "" || /^https:\/\//.test(v), "The renew link must start with https://"),
  });
}
export type ReminderSettingsBody = z.infer<typeof ReminderSettingsDto.schema>;

export class UpcomingQueryDto extends BaseDto {
  static override readonly schema = z.object({ days: z.coerce.number().int().min(1).max(31).default(7) });
}

export class ReminderLogQueryDto extends BaseDto {
  static override readonly schema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    ndid: z.string().trim().min(1).max(64).optional(),
    before: z.iso.datetime().optional().meta({ description: "sentAt of the last row shown; returns older ones" }),
  });
}
export type ReminderLogQuery = z.infer<typeof ReminderLogQueryDto.schema>;

export class SendRemindersDto extends BaseDto {
  static override readonly schema = z.object({
    ndids: z
      .array(z.string().trim().min(1).max(64))
      .min(1, "Pick at least one client")
      .max(50, "At most 50 clients at a time"),
  });
}
export type SendRemindersBody = z.infer<typeof SendRemindersDto.schema>;

// ── responses ───────────────────────────────────────────────────────────────

const settingsSchema = ReminderSettingsDto.schema.extend({
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});

export const remindersOverviewSchema = z.object({
  settings: settingsSchema,
  whatsappReady: z.boolean().meta({ description: "the server has Eazotel's WhatsApp number and token" }),
  emailReady: z.boolean().meta({ description: "false on a machine with no mail server: emails only go to the logs" }),
});

const channelSchema = z.object({
  status: z.enum(["sent", "failed", "skipped"]),
  to: z.array(z.string()),
  note: z.string().nullable(),
});

export const reminderLogEntrySchema = z.object({
  id: z.string(),
  ndid: z.string(),
  hotelName: z.string().nullable(),
  planName: z.string().nullable(),
  endDate: z.iso.datetime(),
  offsetDays: z.number().meta({ description: "-7 = a week before the end, 0 = the end day, 3 = three days after" }),
  kind: z.enum(["scheduled", "manual"]),
  email: channelSchema,
  whatsapp: channelSchema,
  by: z.string().nullable(),
  sentAt: z.iso.datetime(),
});
export const reminderLogSchema = z.object({ items: z.array(reminderLogEntrySchema) });

export const upcomingSchema = z.object({
  items: z.array(
    z.object({
      ndid: z.string(),
      hotelName: z.string().nullable(),
      planName: z.string().nullable(),
      endDate: z.iso.datetime(),
      offsetDays: z.number(),
      trial: z.boolean(),
      sendOn: z.iso.datetime(),
    }),
  ),
});

export const sendRemindersSchema = z.object({
  results: z.array(
    z.object({
      ndid: z.string(),
      ok: z.boolean(),
      entry: reminderLogEntrySchema.nullable(),
      error: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ),
  sent: z.number(),
});

export class RemindersResponseDto {
  static overview({ settings, whatsappReady, emailReady }: RemindersOverview): z.infer<typeof remindersOverviewSchema> {
    return {
      settings: { ...settings, updatedAt: settings.updatedAt?.toISOString() ?? null },
      whatsappReady,
      emailReady,
    };
  }

  static entry(e: ReminderLogEntry): z.infer<typeof reminderLogEntrySchema> {
    const channel = (c: ChannelResult) => ({ status: c.status, to: c.to, note: c.note });
    return {
      id: e.id,
      ndid: e.ndid,
      hotelName: e.hotelName,
      planName: e.planName,
      endDate: e.endDate.toISOString(),
      offsetDays: e.offsetDays,
      kind: e.kind,
      email: channel(e.email),
      whatsapp: channel(e.whatsapp),
      by: e.by,
      sentAt: e.sentAt.toISOString(),
    };
  }

  static upcoming(items: UpcomingReminder[]): z.infer<typeof upcomingSchema> {
    return {
      items: items.map((u) => ({
        ndid: u.ndid,
        hotelName: u.hotelName,
        planName: u.planName,
        endDate: u.endDate.toISOString(),
        offsetDays: u.offsetDays,
        trial: u.trial,
        sendOn: u.sendOn.toISOString(),
      })),
    };
  }
}
