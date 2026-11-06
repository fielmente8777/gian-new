// Public API of the admin module. Other modules import from here only (README §3.4).
export { AdminModule, type AdminModuleDeps } from "./admin.module.js";
export { AdminAuthenticateMiddleware } from "./middlewares/admin-authenticate.middleware.js";
export { AdminPermissions } from "./services/admin-permissions.service.js";
export { adminConfig, type AdminConfig } from "./config/admin.config.js";
export type { AdminPermission } from "./constants/admin-permissions.js";
export type { AdminRecord, AdminRole, AssignedProperty } from "./types/admin.types.js";
