import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminRemindersController } from "../controllers/admin-reminders.controller.js";
import {
  ReminderLogQueryDto,
  reminderLogSchema,
  remindersOverviewSchema,
  ReminderSettingsDto,
  SendRemindersDto,
  sendRemindersSchema,
  UpcomingQueryDto,
  upcomingSchema,
} from "../dtos/admin-reminders.dto.js";
import type { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";

/**
 * /api/v1/admin/reminders/*: renewal reminders by email and WhatsApp. billing.view sees them,
 * billing.manage changes the schedule, subscriptions.manage sends one by hand.
 */
export class AdminRemindersRoutes extends BaseRoutes {
  constructor(c: AdminRemindersController, auth: AdminAuthenticateMiddleware) {
    super("/admin/reminders", { tag: "Admin reminders" });

    this.get(
      "/",
      {
        summary: "The reminder schedule, and whether email and WhatsApp can go out",
        response: { schema: remindersOverviewSchema },
      },
      auth.require("billing.view"),
      c.overview,
    );
    this.put(
      "/settings",
      {
        summary: "Change the reminder schedule",
        description:
          "Off by default. Reminders go out from `sendHourIst` (India time) on the days chosen before the end, on " +
          "the end day and after it. Nobody stopped by staff (paused, expired, in the trash) or with auto-renew " +
          "on (before the end) is reminded. WhatsApp needs the approved template; its body takes 4 values: " +
          "hotel, plan, when, renew link. Logged.",
        body: ReminderSettingsDto,
        response: { schema: remindersOverviewSchema },
      },
      auth.require("billing.manage"),
      c.saveSettings,
    );
    this.get(
      "/upcoming",
      {
        summary: "Who gets which reminder in the coming days",
        query: UpcomingQueryDto,
        response: { schema: upcomingSchema },
      },
      auth.require("billing.view"),
      c.upcoming,
    );
    this.get(
      "/log",
      {
        summary: "Reminders sent, newest first, with how each channel went",
        query: ReminderLogQueryDto,
        response: { schema: reminderLogSchema },
      },
      auth.require("billing.view"),
      c.history,
    );
    this.post(
      "/send",
      {
        summary: "Send a reminder now",
        description:
          "To each client picked (up to 50), whatever the schedule, even with reminders switched off. The words " +
          "match how far the plan is from its end. Each send is logged.",
        body: SendRemindersDto,
        response: { schema: sendRemindersSchema },
      },
      auth.require("subscriptions.manage"),
      c.send,
    );
  }
}
