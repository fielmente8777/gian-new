import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminSubscriptionsController } from "../controllers/admin-subscriptions.controller.js";
import {
  ChangePlanDto,
  appListSchema,
  planListSchema,
  SetAppsDto,
  RenewSubscriptionDto,
  StopSubscriptionDto,
  SubscriptionListQueryDto,
  subscriptionPageSchema,
  SubscriptionParamsDto,
  subscriptionViewSchema,
} from "../dtos/admin-subscriptions.dto.js";
import type { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";

const VIEW = { schema: subscriptionViewSchema };
const NOT_FOUND = { 404: "CLIENT_NOT_FOUND, SUBSCRIPTION_NOT_FOUND" };

/**
 * /api/v1/admin/plans and /api/v1/admin/subscriptions/*: staff only (admin token). The hotel
 * dashboard has its own /api/v1/subscription/* in gian; the two never share a path or a token.
 */
export class AdminSubscriptionsRoutes extends BaseRoutes {
  constructor(c: AdminSubscriptionsController, auth: AdminAuthenticateMiddleware) {
    super("/admin", { tag: "Admin subscriptions" });
    const view = auth.require("subscriptions.view");
    const manage = auth.require("subscriptions.manage");

    this.get(
      "/plans",
      { summary: "The plans a client can be on", response: { schema: planListSchema } },
      view,
      c.plans,
    );
    this.get(
      "/apps",
      { summary: "The add-on apps a client can have", response: { schema: appListSchema } },
      view,
      c.apps,
    );
    this.put(
      "/subscriptions/:ndid/apps",
      {
        summary: "Set exactly which apps the client has, and until when",
        description:
          "Replaces the subscription's app list (one entry per app, merging the duplicates payments left). Listed apps " +
          "are turned on in the hotel dashboard (appAccess), unlisted ones are removed and turned off. Logged.",
        params: SubscriptionParamsDto,
        body: SetAppsDto,
        response: VIEW,
        errors: { ...NOT_FOUND, 400: "APP_NOT_FOUND" },
      },
      manage,
      c.setApps,
    );
    this.get(
      "/subscriptions",
      {
        summary: "Every client's subscription",
        description: "Ordered by ndid; page with `after`=`nextCursor`. Admins see only their assigned clients.",
        query: SubscriptionListQueryDto,
        response: { schema: subscriptionPageSchema },
      },
      view,
      c.list,
    );
    this.get(
      "/subscriptions/:ndid",
      {
        summary: "One client's subscription, and which services run",
        params: SubscriptionParamsDto,
        response: VIEW,
        errors: NOT_FOUND,
      },
      view,
      c.get,
    );
    this.post(
      "/subscriptions/:ndid/pause",
      {
        summary: "Pause: the dashboard asks to renew, the chatbot hides, leads are kept but not sent",
        description: "The days left are kept and given back on resume. Pausing a paused subscription changes nothing.",
        params: SubscriptionParamsDto,
        body: StopSubscriptionDto,
        response: VIEW,
        errors: NOT_FOUND,
      },
      manage,
      c.pause,
    );
    this.post(
      "/subscriptions/:ndid/resume",
      {
        summary: "Resume a paused subscription with the days it had left",
        description:
          "Services come back; held leads move into the dashboard and the hotel gets one email listing them.",
        params: SubscriptionParamsDto,
        response: VIEW,
        errors: NOT_FOUND,
      },
      manage,
      c.resume,
    );
    this.post(
      "/subscriptions/:ndid/renew",
      {
        summary: "Renew (and optionally change plan)",
        description:
          "`months` are added to the current end, or to today if it has passed; a paused subscription first gets its " +
          "days back. Or send an exact last day in `until`. Clears any pause or staff expiry: services come back and " +
          "held leads are released with one catch-up email. Records no payment: put the payment reference in `note`.",
        params: SubscriptionParamsDto,
        body: RenewSubscriptionDto,
        response: VIEW,
        errors: { ...NOT_FOUND, 400: "PLAN_NOT_FOUND" },
      },
      manage,
      c.renew,
    );
    this.post(
      "/subscriptions/:ndid/expire",
      {
        summary: "Expire now: like pause, but the remaining days are not kept",
        params: SubscriptionParamsDto,
        body: StopSubscriptionDto,
        response: VIEW,
        errors: NOT_FOUND,
      },
      manage,
      c.expire,
    );
    this.put(
      "/subscriptions/:ndid/plan",
      {
        summary: "Upgrade or downgrade the plan without changing the dates",
        params: SubscriptionParamsDto,
        body: ChangePlanDto,
        response: VIEW,
        errors: { ...NOT_FOUND, 400: "PLAN_NOT_FOUND" },
      },
      manage,
      c.changePlan,
    );
  }
}
