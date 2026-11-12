/**
 * What staff can do. Base permissions come with every admin account. Advanced permissions are
 * given to an admin one by one by a super admin. Super-only permissions can never be given:
 * the only way to get them is the super_admin role. A super admin always has all of them.
 */
export const ADMIN_BASE_PERMISSIONS = ["clients.view", "clients.edit", "subscriptions.view", "credits.view"] as const;

export const ADMIN_ADVANCED_PERMISSIONS = [
  "subscriptions.manage",
  "credits.manage",
  "credits.pricing",
  "clients.open_account",
  // revenue and payments
  "billing.view",
  // plans, prices, add-on apps, billing cycles, GST and offers
  "billing.manage",
  // every Facebook page from the Meta sign-ins, and which client gets each page's leads
  "meta_pages.manage",
  // move clients to the trash (hidden, subscription paused, nothing deleted) and restore them
  "clients.trash",
] as const;

export const ADMIN_SUPER_PERMISSIONS = ["team.manage", "audit.view", "clients.delete"] as const;

export type AdminAdvancedPermission = (typeof ADMIN_ADVANCED_PERMISSIONS)[number];
export type AdminPermission =
  (typeof ADMIN_BASE_PERMISSIONS)[number] | AdminAdvancedPermission | (typeof ADMIN_SUPER_PERMISSIONS)[number];

export const ALL_ADMIN_PERMISSIONS: readonly AdminPermission[] = [
  ...ADMIN_BASE_PERMISSIONS,
  ...ADMIN_ADVANCED_PERMISSIONS,
  ...ADMIN_SUPER_PERMISSIONS,
];
