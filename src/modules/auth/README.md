# auth module

Logs in everyone who uses Eazotel: hotel users on the **dashboard** (browser) and the **Android app**,
and the **Eazotel + Fielmente team** (staff), who can open any client account. gian-new is the
only backend: it replaces nexon's and gian's login. Old clients (today's dashboard and app, which
hold nexon tokens) keep working until they are updated.
Status (2026-11-03): **built and tested** (52 tests, plus a run against a real MongoDB). Not deployed yet.

## 1. Endpoints

### New API (`/api/v1/auth`, strict CORS, standard envelope)

| Method + path | Auth | Body | Answer |
|---|---|---|---|
| `POST /api/v1/auth/login` | public, rate limited | `{ email, password }` | 200 session |
| `POST /api/v1/auth/register` | public, rate limited | `{ email, password (8+), name, phone? }` | 201 session; 409 `EMAIL_TAKEN` |
| `POST /api/v1/auth/google` | public, rate limited | `{ idToken }` (Google button credential) | 200 session, 201 when the account was created |
| `POST /api/v1/auth/refresh` | refresh cookie | – | 200 session, cookie rotated |
| `POST /api/v1/auth/logout` | refresh cookie | – | 204, cookie cleared |
| `GET /api/v1/auth/me` | access or nexon token | – | 200 user |
| `POST /api/v1/auth/password` | access or nexon token | `{ currentPassword, newPassword }` | 204; other devices logged out |
| `POST /api/v1/auth/legacy/exchange` | **nexon token** | – | 200 session (moves a nexon login to the new tokens) |
| `GET /.well-known/jwks.json` | public | – | public keys (other services verify our tokens with them) |

A session response is `{ success: true, data: { accessToken, tokenType: "Bearer", expiresAt, isStaff, user } }`.

**Browser vs app.** Send `X-Client-Platform: android` (or `ios`), plus optionally `X-Device-Id: <stable id>`:

| | Dashboard (browser) | Android / iOS app |
|---|---|---|
| refresh token after login | `ez_rt` cookie only (httpOnly, Secure, SameSite=Lax, Path=/api/v1/auth). Page JavaScript can't read it | in the body: `refreshToken`, `refreshTokenExpiresAt`. Store it in the Android Keystore (EncryptedSharedPreferences) / iOS Keychain |
| `/refresh`, `/logout` | nothing in the body (cookie) | `{ "refreshToken": "…" }`; the new one comes back in the body |
| Google sign-in | `idToken` from the Google button | `idToken` from Credential Manager / Google Sign-In, requested with `serverClientId` = the **web** client id |
| every other call | `Authorization: Bearer <accessToken>` | same |

A refresh token always comes back the way it was sent: body in, body out; cookie in, cookie out.
The platform and device are stored with the session, so a "log out this device" screen is possible later.

### Old nexon paths (open CORS, nexon's exact bodies)

| Path | Behaves like nexon's | Notes |
|---|---|---|
| `POST /eazotel/ceateuser` | `controller/eazotel.py createUser` | login, or sign-up when `register === "true"`. Returns a nexon-style token |
| `POST /user/googleauth` | `controller/users.py google_login_and_signup` | `Authorization: Bearer <Google ID token>` |
| `POST /eazotel/edit/password` | `controller/eazotel.py editUser_password` | `{ token, oldAccessId, newAccessId }` |
| `POST /admin/switch-account` | `controller/admin.py switchAccount` | **Retired**: always `403 { Status: false, Message }`. nexon signs a token for anyone who asks. Staff open client accounts from the admin console instead |

They only receive traffic after nginx sends the path to gian-new (README §9.2). They are mounted only when `AUTH_LEGACY_JWT_SECRET` is set.

## 2. Tokens

| | Access token (new) | nexon token (legacy) | Refresh token |
|---|---|---|---|
| Format | JWT **RS256**, `kid` header | JWT HS256 `{ Email, exp }` | 32 random bytes (base64url) |
| Lifetime | 15 min (`AUTH_ACCESS_TTL`) | 15 days | 30 days, renewed on every refresh |
| Who can create one | only gian-new (private key) | anyone with the shared secret (nexon, gian, gian-new) | gian-new |
| Stored | nowhere | nowhere | only its SHA-256, in `auth_refresh_tokens` |
| Claims | `sub, sid, ndid, email, role, admin, perms[], props[{hid, perms[]}], staff, act?, typ, iss, aud, iat, exp, jti` | `Email` | – |

- `perms` = the `accessScope` flags that are `true` (`cms`, `bookingEngine`, …). `props` = `assigned_location`.
- **Permission rule** (`AuthContext.can`): on a property the user is assigned to, that property's flags decide. On any other property, only an owner (`isAdmin`) has access, with the account flags. Checking that the `hid` belongs to the owner's `ndid` is the properties module's job.
- The middleware chooses how to verify a token by its `alg` header: RS256 → `AccessTokenStrategy` (no DB call), HS256 → `LegacyTokenStrategy` (looks up the email, like gian's `authMiddleware`).
- **Staff** (`staff: true`) grants nothing today; it is kept so the hotel dashboard can tell staff apart later. This login was **Google with a verified email on `AUTH_STAFF_EMAIL_DOMAINS`** (eazotel.com, fielmente.com). A typed email proves nothing (anyone can register `x@eazotel.com` with a password, and nexon lets a hotel give its users role `owner`), so password logins are never staff. The refresh token remembers the flag; removing a domain from the env ends staff rights at the next refresh. With an **old nexon token** the login method is unknown, so staff = a staff-domain email whose account has been linked to Google (only a Google sign-in links it).
- **Opening a client account** is the admin module's job (`POST /api/v1/admin/clients/:ndid/open-account`): it checks `admin_users`, the `clients.open_account` permission and the person's assigned properties, writes the audit log, then asks this module's `ClientAccountTokens` for a nexon-style token for the account holder (`AUTH_IMPERSONATION_TTL`, 1 hour, no refresh). It is nexon-style because the hotel dashboard still calls nexon and gian. Once it runs on our tokens, issue an access token with `act: { sub, email }` instead (`AuthContext` and `/me` `switchedBy` already handle that claim).
- Refresh rotation with reuse detection: a token that has already been replaced and is used again (after a 10 s grace period for two tabs refreshing at once) revokes the whole session family.

## 3. Passwords during the migration

Both nexon and gian-new can change a password, so neither can simply overwrite the other.

```text
login(password):
  credential = auth_credentials[user]            bcrypt hash + legacyHash (= accesskey when it was written)
  if credential.legacyHash == Zucks_users.accesskey  → bcrypt.compare            (nobody changed it in nexon)
  else                                               → sha256(password) == accesskey ?   (nexon is the truth)
                                                        yes → write a new bcrypt credential (upgrade)
set password:  bcrypt → auth_credentials, and accesskey = sha256(new) while AUTH_LEGACY_PASSWORD_SYNC=true
```

- There is no migration script. Every user is upgraded on their first login through gian-new.
- Accounts created through Google sign-up start with the default password `Eazotel@123`, as in nexon, and hotels can change it after logging in. This is the owner's decision (2026-11-06), so keep it.
- Unknown emails take the same time as wrong passwords, so attackers can't tell which emails have accounts.
- When nexon is retired, set `AUTH_LEGACY_PASSWORD_SYNC=false` and `accesskey` stops being written.

## 4. Classes (one job each)

| Folder | Class | Job |
|---|---|---|
| `auth.module.ts` | `AuthModule` | builds everything below; exposes `authenticate`, `tokens` and the routers |
| `services/` | `AuthService` | who is this user? (login methods, register, change password, inactive accounts) |
| | `SessionService` | logged-in sessions: start, refresh and end them |
| | `TokenService` | sign and verify RS256 access tokens, JWKS |
| | `RefreshTokenService` | issue, rotate and revoke refresh tokens |
| | `CredentialService` | the bcrypt/nexon password rules in §3 |
| | `StaffPolicy` | who is Eazotel / Fielmente staff |
| | `PasswordService` · `LegacyPasswordHash` | bcrypt · nexon SHA-256 |
| | `LegacyTokenService` | sign and verify nexon HS256 tokens |
| `strategies/` | `PasswordStrategy`, `GoogleStrategy` | the login methods (`LoginStrategy`) |
| | `AccessTokenStrategy`, `LegacyTokenStrategy` | the token types (`TokenStrategy`) |
| `middlewares/` | `AuthenticateMiddleware` | `require(permission?, { hid })` on routes; sets `req.auth` |
| `controllers/` | `AuthController`, `AuthLegacyController`, `JwksController`, `RefreshCookie` | HTTP only |
| `repositories/` + `models/` | `CredentialRepository`, `RefreshTokenRepository` | `auth_credentials`, `auth_refresh_tokens` (new collections, owned here) |
| `types/` | `AuthContext` | the authenticated user on `req.auth`, plus `can()` |

Other modules use only `index.ts`: `AuthModule`, `AuthenticateMiddleware`, `AuthContext`.

```ts
// in another module's routes
this.routes.put("/:hid/rooms", auth.require("bookingEngine", { hid: (req) => req.params.hid }), c.update);
// in its controller
const { ndid } = AuthContext.of(req);   // tenant from the token, never from the body
```

## 5. Collections

| Collection | Owner | Written by gian-new |
|---|---|---|
| `Zucks_users` | users module (shared with nexon/gian) | `$set` on `google_id`, `accesskey` only; new owners in nexon's exact shape |
| `auth_credentials` | auth | `{ userId (unique), passwordHash, legacyHash }` |
| `auth_refresh_tokens` | auth | `{ tokenHash (unique), familyId, userId, audience, expiresAt (TTL), revokedAt, revokedReason, replacedByHash, ip, userAgent }` |

`AuthModule.init()` builds the indexes for the two `auth_*` collections at startup. They are new and small, so this is safe. It never builds indexes on `Zucks_users`.

## 6. Differences from nexon (deliberate)

| nexon | gian-new |
|---|---|
| sign-up checks email **and** password, so the same email with another password creates a second account | checks the email only (any letter case) → `EMAIL_TAKEN` |
| password login ignores `isActive` | inactive accounts are refused everywhere |
| Google login accepts unverified emails | verified emails only. New accounts get the default password `Eazotel@123`, same as nexon |
| token `Email` = the email as the user typed it (so gian's exact `emailId` lookup can miss) | the stored email |
| no rate limit | 10 failed logins per IP + email per 15 min |
| unsalted SHA-256 | bcrypt (12 rounds), SHA-256 written only for nexon while sync is on |

## 7. Not done yet (next steps)

- **users routes**: `/user/user-details`, `/eazotel/getuser/<token>`, team management (`/user/create`, `/user/edit`, `/user/delete`).
- **forgot password** (reset link by email; needs the messaging module). nexon's version is unsafe, see the main README §9.6.
- **phone OTP** (needs WhatsApp/SMS), **guest tokens** for `/feature1/*` (booking engine "my bookings").
- **client list for staff** (`/admin/get-all-clients` reads `Zucks_profile`; lands with the properties module, guarded by `isStaff`).
- **push devices for the app** (gian `/api/v1/fcm/device`, collection `fcm_devices`, keyed by email): moves into a notifications module. App logout should also remove the device.
- `Super_admins` (nexon's separate admin accounts with SHA-256 passwords) is not used: staff log in with Google instead. Retire `/admin/login`.
- A **subscription listener** for `user.registered`. nexon calls gian `/user/subscribe` on sign-up, so `/eazotel/ceateuser` must not be switched in nginx until this exists.
- Redis store for the rate limiter once more than one container runs.
- Golden-file tests recorded from the real nexon (README §9.4).
