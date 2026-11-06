import { ADMIN_BASE_PERMISSIONS, ALL_ADMIN_PERMISSIONS, type AdminPermission } from "../constants/admin-permissions.js";
import type { AdminRecord } from "../types/admin.types.js";

/** Answers "what may this staff member do, and where?". The one place these rules live. */
export class AdminPermissions {
  static isSuperAdmin(admin: AdminRecord): boolean {
    return admin.role === "super_admin";
  }

  static effective(admin: AdminRecord): AdminPermission[] {
    if (AdminPermissions.isSuperAdmin(admin)) return [...ALL_ADMIN_PERMISSIONS];
    return [...ADMIN_BASE_PERMISSIONS, ...admin.advancedPermissions];
  }

  static has(admin: AdminRecord, permission: AdminPermission): boolean {
    return AdminPermissions.effective(admin).includes(permission);
  }

  /**
   * The properties this person may see, as hids per client ndid. Null means every property
   * (super admins). An admin sees a client once any of its properties is assigned to them,
   * and within it only their assigned properties.
   */
  static propertyScope(admin: AdminRecord): Map<string, Set<string>> | null {
    if (AdminPermissions.isSuperAdmin(admin)) return null;
    const scope = new Map<string, Set<string>>();
    for (const { ndid, hid } of admin.assignedProperties) {
      scope.set(ndid, (scope.get(ndid) ?? new Set()).add(hid));
    }
    return scope;
  }
}
