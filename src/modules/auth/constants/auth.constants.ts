/** The refresh cookie is only sent to the auth routes, never to the rest of the API. */
export const REFRESH_COOKIE_PATH = "/api/v1/auth";

/** Random bytes in a refresh token (256 bits). */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * Two tabs refreshing at the same moment both present the same token. The loser of that
 * race gets a 401 instead of the whole session being revoked as a token theft.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000;

/** Window for AUTH_LOGIN_MAX_ATTEMPTS. */
export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60_000;

/** Value of the `typ` claim in access tokens; anything else is rejected. */
export const ACCESS_TOKEN_TYPE = "access";

/**
 * The starting password of every account created through Google sign-up, same as nexon
 * (user_usecase.py). Hotels use it and can change it after logging in. Decided by the owner,
 * 2026-11-06: keep it. Don't remove it or refuse it at login.
 */
export const GOOGLE_SIGNUP_DEFAULT_PASSWORD = "Eazotel@123";
