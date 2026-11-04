/**
 * The feature flags nexon stores in Zucks_users.accessScope (model/accessScope.py).
 * Each `true` flag becomes a permission in the access token (e.g. "bookingEngine").
 */
export const ACCESS_SCOPE_KEYS = [
  "bookingEngine",
  "channelManager",
  "cms",
  "foodManager",
  "frontDesk",
  "gatewayManager",
  "reservationDesk",
  "seoManager",
  "socialMedia",
  "themes",
  "enquiriesManagement",
  "guestRequestManagement",
  "humanResourceManagement",
  "leadgenform",
  "conversationaltool",
  "eazbot",
  "usermanagement",
  "emailmarketing",
  "whatsappmarketing",
  "smsmarketing",
  "analyticsandreporting",
  "whatsapp",
] as const;

export type AccessScopeKey = (typeof ACCESS_SCOPE_KEYS)[number];

/** What a new account owner gets (nexon gives every self-registered owner everything). */
export const FULL_ACCESS_SCOPE: Readonly<Record<AccessScopeKey, boolean>> = Object.freeze(
  Object.fromEntries(ACCESS_SCOPE_KEYS.map((key) => [key, true])) as Record<AccessScopeKey, boolean>,
);

/** Role nexon gives the account owner. */
export const OWNER_ROLE = "superadmin";
