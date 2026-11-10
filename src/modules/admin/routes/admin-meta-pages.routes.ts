import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminMetaPagesController } from "../controllers/admin-meta-pages.controller.js";
import {
  LinkMetaPageDto,
  MetaConnectionParamsDto,
  metaPageSchema,
  MetaPageParamsDto,
  metaPagesOverviewSchema,
  metaSyncResultSchema,
} from "../dtos/admin-meta-pages.dto.js";
import type { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";

/**
 * /api/v1/admin/meta-pages/*. Every route needs `meta_pages.manage` (advanced; super admins
 * have it). Linking a page decides whose dashboard its Facebook leads reach.
 */
export class AdminMetaPagesRoutes extends BaseRoutes {
  constructor(c: AdminMetaPagesController, auth: AdminAuthenticateMiddleware) {
    super("/admin/meta-pages", { tag: "Admin Meta pages" });
    const manage = auth.require("meta_pages.manage");

    this.get(
      "/",
      {
        summary: "Every Facebook page from every sign-in with Meta, and the client each one is linked to",
        description:
          "One row per page, merged over the pageconnections documents that have it. `link` is where gian's lead " +
          "webhook sends new leads; null means they reach nobody. `conflict` means copies point at different clients.",
        response: { schema: metaPagesOverviewSchema },
      },
      manage,
      c.overview,
    );
    this.put(
      "/:pageId/link",
      {
        summary: "Send this page's leads to a client property",
        description:
          "Written to the page in every Meta connection that has it. New leads go to this ndid and hid from the " +
          "next one; leads already saved stay where they are. Admins can only link their own properties. Logged.",
        params: MetaPageParamsDto,
        body: LinkMetaPageDto,
        response: { schema: metaPageSchema },
        errors: {
          403: "META_PAGE_OUT_OF_SCOPE",
          404: "META_PAGE_NOT_FOUND, CLIENT_NOT_FOUND, PROPERTY_NOT_FOUND",
        },
      },
      manage,
      c.link,
    );
    this.delete(
      "/:pageId/link",
      {
        summary: "Unlink a page: its new leads reach no client",
        params: MetaPageParamsDto,
        response: { schema: metaPageSchema },
        errors: { 403: "META_PAGE_OUT_OF_SCOPE", 404: "META_PAGE_NOT_FOUND" },
      },
      manage,
      c.unlink,
    );
    this.post(
      "/connections/:connectionId/sync",
      {
        summary: "Fetch a connection's pages from Meta again",
        description:
          "Uses the token saved at sign-in. New pages are added (with the link they have elsewhere), names and page " +
          "tokens refreshed, links kept, and every page subscribed to lead webhooks. Pages Meta no longer returns " +
          "are kept and listed as `missing`. Logged.",
        params: MetaConnectionParamsDto,
        response: { schema: metaSyncResultSchema },
        errors: {
          404: "META_CONNECTION_NOT_FOUND",
          409: "META_TOKEN_MISSING",
          422: "META_SYNC_FAILED",
        },
      },
      manage,
      c.sync,
    );
  }
}
