import { BaseRoutes } from "../../../shared/http/base-routes.js";

/** Everything under /api/v1/admin, because a module gives the app a single router. */
export class AdminRoutes extends BaseRoutes {
  constructor(...groups: BaseRoutes[]) {
    super();
    for (const group of groups) this.include(group);
  }
}
