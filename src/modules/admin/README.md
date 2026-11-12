# Admin module

The backend of the Eazotel staff console. Staff are kept completely apart from hotel accounts.

| | Hotel dashboard (`auth` module) | Admin console (this module) |
|---|---|---|
| People | `Zucks_users` | `admin_users` |
| Login | `/api/v1/auth/*` | `/api/v1/admin/auth/*` |
| Token audience | `eazotel-app` | `eazotel-admin` |
| Refresh cookie | `ez_rt` | `ez_admin_rt` |
| Who can get in | Anyone can sign up | Only people already listed |

A token from one side is rejected by the other.

## Login flow

1. **`POST /admin/auth/google`**: verifies the Google token. The email must already be in `admin_users` and active. Nothing is created for an unknown email. Emails a 6-digit code and returns a `challengeId`.
2. **`POST /admin/auth/otp/verify`**: checks the code and starts the session (access token + `ez_admin_rt` cookie).

Unknown, disabled and wrong-Google-account logins all get the same `ADMIN_NOT_ALLOWED`, so nobody can find out who is staff.

**Code rules:** random, 5 minutes, single use, only the hash is stored. A login gets 5 wrong attempts, and asking for a new code does not reset them. New codes need a 60-second wait, with at most 4 emails per login.

The code is needed at each new login. Refreshing the session does not ask again. A session is sliding: it ends after `ADMIN_REFRESH_TTL_DAYS` (30 days) **without use**, and every visit pushes that forward, so staff who use the console stay signed in until they log out (like Gmail).

Reloads never sign anyone out (2026-11-12): a refresh cookie whose renewal never reached the browser (page reloaded or tab closed mid-refresh, two tabs at once) still works while its replacement is unused, and a refresh that races another answers 409 `REFRESH_IN_PROGRESS` without touching the cookie (the console retries). Only an old cookie whose replacement *was* used counts as theft and ends the session. The console treats only 401/403 as signed out; an unreachable server shows "reconnecting" instead of the login page. Unknown console URLs redirect to the overview (or login).

Access tokens hold only the admin's id and session. Role and permissions are read from the database on every request, so disabling someone applies to their next click.

## Roles and permissions

| | Super admin | Admin |
|---|---|---|
| Properties | All | Those in `assignedProperties`, with no limit. Several admins may hold the same one |
| Base permissions (`clients.view`, `clients.edit`, `subscriptions.view`, `credits.view`) | Yes | Yes, automatically |
| Advanced permissions (`subscriptions.manage`, `credits.manage`, `credits.pricing`, `clients.open_account`, `billing.view`, `billing.manage`, `meta_pages.manage`, `clients.trash`) | Yes | Only when a super admin gives them |
| Super-only permissions (`team.manage`, `audit.view`, `clients.delete`) | Yes | Never. They can't be given, only the role carries them |

Rules live in `AdminPermissions`. Protect a route with `auth.require("credits.manage")`.

## Team management

Super admins only.

| Route | What it does |
|---|---|
| `GET /admin/team` | Everyone on the team |
| `POST /admin/team` | Adds someone, who can then sign in with Google. `409 TEAM_MEMBER_EXISTS` if the email is taken |
| `PATCH /admin/team/:id` | Changes name, role, status, advanced permissions or assigned properties. The email never changes |

Changes apply on the person's next request. Disabling someone also ends their sessions, so turning them back on later doesn't bring old browser sessions back.

**The team can't lock itself out:** nobody can change their own role or status (`CANNOT_CHANGE_OWN_ACCESS`), and a change that would leave fewer than two active super admins is refused (`SUPER_ADMIN_MINIMUM`). While the team has only one super admin, they can add a second one here.

The team screen picks properties by searching clients. The API itself doesn't check that a property exists, so a script sending a wrong ndid or hid saves it as sent.

## Clients

A client is one hotel group: a `Zucks_profile` document (read through the `profiles` module), with its properties in `hotels.<hId>`. The account holder comes from `Zucks_users` through the `users` module.

| Route | Permission | What it does |
|---|---|---|
| `GET /admin/clients` | `clients.view` | Search by hotel name, domain, hotel email or exact ndid. Pages with `after`=`nextCursor` |
| `GET /admin/clients/:ndid` | `clients.view` | Profile, properties and account holder |
| `PATCH /admin/clients/:ndid` | `clients.edit` | Description, hotel email, hotel phone, marketing email, and each property's name, city, state, country and PIN code. Only the fields sent change; empty text clears one |

**Scope:** super admins see every client. An admin sees a client once any of its properties is assigned to them, and inside it only those properties. Anything outside that answers `404 CLIENT_NOT_FOUND` or `PROPERTY_NOT_FOUND`, the same as something that doesn't exist.

**Not editable here, on purpose:**
- **Hotel name:** nexon's booking-engine currency update finds the profile by matching `hotelName` against the booking engine's own copy, so renaming only the profile would break it.
- **Domain and plan:** the domain is wired into the website and booking engine, and the plan belongs to the subscriptions work.
- **Owner login email:** needs the hotel email-change flow with an OTP.

Edits write only `Zucks_profile`. The website (`WebsiteData`) and booking engine (`BookingEngineData`) keep their own copies of contact details, so a changed hotel phone doesn't reach them.

### Lead alerts

| Route | Permission | What it does |
|---|---|---|
| `GET /admin/clients/:ndid/notifications` | `clients.view` | Each visible property's email and WhatsApp alerts per lead source, the hotel's own email and phone, and `leadsDelivered` |
| `PUT /admin/clients/:ndid/notifications/:hid` | `clients.edit` | Saves all five sources of one property. Logged as `client.notifications_changed`, one line per switch or address list that changed |

These are the hotel's own settings (`hotelnotifications`, see `../hotel-notifications/README.md`). Staff and the hotel edit the same copy, so the last save wins. The Leads switch and a stopped subscription override them: `leadsDelivered: false` means nothing is sent.

### Team WhatsApp numbers (2026-11-12)

The hotel dashboard's Team management list and its lead-alert picker read only `Zucks_users.phone`. nexon's Google sign-up stores no phone for the account holder, and the website's email sign-up sends none, so owners showed "—" and could not be picked for WhatsApp alerts.

| Route | Permission | What it does |
|---|---|---|
| `GET /admin/team-phones/missing-owners` | `clients.view` | Account holders (oldest admin of each ndid) with no phone, within the person's properties, trash left out (max 500). `suggestedPhone` = the hotel phone Fix would copy, null when it has no country code |
| `POST /admin/team-phones/fix-owners` | `clients.edit` | `{ ndids }` (max 100). Per client: `fixed`, `has_phone`, `no_hotel_phone` or `not_found`. Logged as `client.owner_phone_filled` |
| `GET /admin/team-phones/:ndid` | `clients.view` | Every dashboard user, owner first, their phone and whether it gets WhatsApp lead alerts |
| `PUT /admin/team-phones/:ndid/:userId` | `clients.edit` | `{ phone, addToAlerts }`. Saved as `+<digits>`, a 10-digit number as +91, empty clears. Logged as `client.team_phone_changed` |

Rules (`services/admin-team-phones.service.ts` `OwnerPhoneFiller`, also used by `scripts/backfill-owner-phones.ts`, `npm run owners:backfill-phones [-- --apply]`): a stored phone is never replaced (the update filter requires it empty); only the account holder is filled; a hotel phone without a country code is never guessed (gian sends to the stored digits); the number goes onto every lead source's `phone[]` of each property via `HotelNotificationsPort.addPhone`, which skips lists that already hold it in any format and never changes a switch or email. gian's onboarding (`src/services/ownerContact.service.ts`) applies the same rules to every new sign-up.

### Service switches

| Route | Permission | What it does |
|---|---|---|
| `GET /admin/clients/:ndid/services` | `subscriptions.view` | Whether the chatbot and leads run for the client, and how many leads are held |
| `PUT /admin/clients/:ndid/services/:service` `{ enabled }` | `subscriptions.manage` | Turns `chatbot` or `leads` on or off. gian-new and gian apply it within 30 seconds. Turning leads on releases the held leads (and again 40 seconds later). Logged |

What "off" does, who obeys it and the known gaps are in `../client-services/README.md`.

### Opening a client's account

`POST /admin/clients/:ndid/open-account` signs staff in to the hotel dashboard as that hotel, for one hour (`AUTH_IMPERSONATION_TTL`, no refresh). It needs `clients.open_account`, and the client must be within the person's properties. It refuses a client with no account (`CLIENT_ACCOUNT_NOT_FOUND`) or a turned-off one (`CLIENT_ACCOUNT_INACTIVE`), and logs `client.account_opened`.

The token is nexon-style, because the hotel dashboard still calls nexon and gian (see the auth README). The admin console opens `<hotel dashboard>/staff-access#token=…&ndid=…&hid=…` in a new tab. The hotel dashboard stores the token and clears the address bar.

This replaced switching by email domain. `/api/v1/auth/switch-account` is gone, and the old `/admin/switch-account` path always answers 403. nexon's own `/admin/switch-account` still signs a token for anyone until nginx sends that path here.

Every real change goes to the audit log as `client.updated`, with old and new values. Search uses a case-insensitive regex, which scans the collection; that is fine at today's size.

## Audit log

`admin_audit_logs` records logins (including refused ones and why) and every team change, with old and new values. `GET /admin/audit-log` reads it newest first, filtered by `action` or `email`, and pages with `before`=`nextCursor`. Nothing in the API can edit or delete a line.

Every entry also goes to the server logs. If saving one fails, the error is logged and the staff member's action still counts as done, so that log is the backup record.

## Creating the first super admins

Nobody can sign up, so the first super admin comes from a script. After that, super admins add people from the team screen. Keep at least two.

```bash
docker compose exec api npx tsx scripts/create-admin.ts you@eazotel.com "Your Name"
```

Without Docker: `npx tsx scripts/create-admin.ts you@eazotel.com "Your Name"`. Add `--role admin` for a normal admin. Running it again for an existing person restores them to that role and makes them active.

## Email

Codes go through `integrations/mail`. With `MAIL_SMTP_HOST` empty and `APP_ENV=development`, the email is printed to the logs instead of sent (`docker compose logs api`). On any other `APP_ENV` the app refuses to start without a mail server.

## Deleting a client

Super admins only (`clients.delete` can't be given to an admin), for demo and wrong accounts.

| Route | What it does |
|---|---|
| `GET /admin/clients/:ndid/deletion-preview` | How many records each collection holds for the client |
| `DELETE /admin/clients/:ndid` `{ confirmName, reason? }` | `confirmName` must be the hotel's name (or the ndid when it has none) |

**How it deletes** (`modules/client-archive`):
1. Every collection is searched for `ndid`, `uId` or `NDID` = the client. Staff data (`admin_*`), the catalogues (`plans`, `apps`), the archive itself and anything named `*backup*` are skipped.
2. The hotel users' login records (`auth_credentials`, `auth_refresh_tokens`) are matched by user id.
3. Each batch is **copied to `deleted_client_records`** (`deletionId`, `collection`, the original `doc` with its `_id`) and only then deleted. `deleted_clients` keeps one summary per deletion: who, why, counts.
4. Staff lose the client from their assigned properties, and the delete is logged as `client.deleted`.

To undo, copy the `doc`s of one `deletionId` back into their `collection`. There's no button for this yet.

**Left behind:** a few collections link to a client some other way, such as WhatsApp messages and widgets (by account), chatbot conversations, onboarding and google_properties. Their rows stay, with nothing pointing to them.

## Subscriptions

Super admins, and admins given `subscriptions.manage`, manage each client's subscription (gian's `subscriptions` collection). Anyone with `subscriptions.view` can see them. Only `/api/v1/admin/*` routes with an admin token reach these. The hotel dashboard keeps its own `/api/v1/subscription/*` in gian, so the two never share a path or a token.

| Route | What it does |
|---|---|
| `GET /admin/plans` | The plans (TRIAL, BASIC, PRO, ENTERPRISE) |
| `GET /admin/subscriptions?state=&search=&sort=hotel\|plan\|endDate\|state&order=asc\|desc&page=&pageSize=` | One page of subscriptions, plus `total` and `counts` per state, in one database round trip |
| `GET /admin/subscriptions/:ndid` | One subscription, and which services run |
| `POST /admin/subscriptions/:ndid/pause` `{ reason? }` | End date → now (the hotel dashboard shows its renew page), the days left are kept. The chatbot hides; new lead alerts are held |
| `POST /admin/subscriptions/:ndid/resume` | Gives the kept days back; services return |
| `POST /admin/subscriptions/:ndid/renew` `{ months \| until, planId?, note? }` | Months add to the current end (or today). Clears any pause or expiry. Records no payment: put the reference in `note` |
| `POST /admin/subscriptions/:ndid/expire` `{ reason? }` | Like pause, without keeping the days |
| `PUT /admin/subscriptions/:ndid/plan` `{ planId }` | Upgrade or downgrade, same dates |

### Apps

The add-on apps (gian's `apps` collection, 11 today) live on the subscription in two places that the hotel dashboard reads:
- `apps[]`, one entry `{ appId, isTrial, startDate, endDate }` per app. Its Subscription page shows each app as active or expired from `endDate`.
- `appAccess.<code>`, which actually unlocks the feature in the hotel dashboard.

gian's payment adds new entries to `apps[]` without updating old ones, so duplicates pile up. In November 2026, 25 active subscriptions showed some apps as expired.

| Route | What it does |
|---|---|
| `GET /admin/apps` | The catalogue |
| `PUT /admin/subscriptions/:ndid/apps` `{ apps: [{ appId, endDate: "YYYY-MM-DD", isTrial? }] }` | Sets exactly these apps, one entry each (keeping each app's first start date). Listed apps' `appAccess` → true, other catalogue apps → false; older `appAccess` keys stay. Logged as `subscription.apps_changed` |

`renew` also moves every app to the new end date as paid (`extendApps`, default true). `pause` and `expire` take `endApps` (default false) to also end every app now; a resume then gives the apps the subscription's new end, and a renew extends them. In the console: the **Apps** card on a client page (select all, "Match subscription end", save), and **Match apps to subscription end** in each row menu of the Subscriptions page.

A staff pause or expiry is stored in `staffStop` on the subscription, a field gian doesn't know, so gian's own status values stay valid. Whenever a client is served again (resume, renew, or paying in gian, which the one-minute sweep notices), waiting leads go out in **one** catch-up email. See `../client-services/README.md`.

## Billing (plans, prices, offers, payments)

Built on the `billing` module (`../billing/README.md`). `billing.view` shows revenue and payments; `billing.manage` changes the catalogue. Every change is logged (`billing.plan_created`, `billing.plan_updated`, `billing.app_created`, `billing.app_updated`, `billing.settings_updated`, `billing.offer_created`, `billing.offer_updated`) with old and new values.

| Route | Permission | What it does |
|---|---|---|
| `GET /admin/billing/overview` | `billing.view` | Revenue (this month, last month, 30 days, all time, 12 months), paying / trial / ended hotels, renewals due in 30 days, auto-renew count, hotels per plan, estimated MRR |
| `GET /admin/billing/payments?status&source&ndid&from&to&page&pageSize` | `billing.view` | Every payment (new and old checkout), with hotel name and plan. Admins see only their assigned clients |
| `GET /admin/billing/catalogue` | `billing.view` | Plans (archived and private too), apps, settings, offers |
| `POST /admin/billing/plans`, `PATCH /admin/billing/plans/:id` | `billing.manage` | Price, included apps, limits, bullet points, support, public / custom / private (`visibleTo`), archive |
| `POST /admin/billing/apps`, `PATCH /admin/billing/apps/:id` | `billing.manage` | Add-on apps: name, description, price, available. The code never changes |
| `PUT /admin/billing/settings` | `billing.manage` | Billing cycles and their discounts, GST %, extra seat price, trial days, and Eazotel's invoice details (`invoice`: name, address, state, GSTIN, PAN, SAC, number prefix) |
| `GET /admin/billing/invoices/:id`, `GET /admin/billing/invoices/:id/pdf` | `billing.view` | An invoice with the suggested recipients; its PDF |
| `POST /admin/billing/invoices/:id/email` `{ to[] }` | `billing.view` | Emails the PDF (no addresses = the hotel's invoice email, hotel email and owner). Logged as `billing.invoice_emailed` |
| `POST /admin/billing/payments/:orderId/invoice` | `billing.manage` | Creates the invoice for an older paid payment. Logged as `billing.invoice_created` |
| `POST /admin/billing/offers`, `PATCH /admin/billing/offers/:id` | `billing.manage` | Offer codes: percent or flat, cap, plans, cycles, kinds, dates, total and per-hotel uses, private hotels, shown on pricing pages |

A price change applies to purchases and renewals from then on. Periods already paid, and auto-renew mandates already set up, keep their amount.

## Meta pages (Facebook lead routing)

Built on the `meta-pages` module (`../meta-pages/README.md`) over gian's `pageconnections`. Every route needs `meta_pages.manage`. Holders see every page (the one to link is usually nobody's yet); an admin can only link to their own properties, and only move pages that are unlinked or already theirs (`META_PAGE_OUT_OF_SCOPE`).

| Route | What it does |
| --- | --- |
| `GET /admin/meta-pages` | Every page once, merged over all sign-ins: `link` (where new leads go, with hotel/property names), `conflict`, each copy; the sign-ins; counts |
| `PUT /admin/meta-pages/:pageId/link` `{ ndid, hid }` | Writes the link to the page in every sign-in that has it. Leads already saved don't move. Logged `meta_page.linked` |
| `DELETE /admin/meta-pages/:pageId/link` | Unlinks it everywhere: new leads reach no client. Logged `meta_page.unlinked` |
| `POST /admin/meta-pages/connections/:connectionId/sync` | Fetches the sign-in's pages from Meta again with its saved token, keeps links, subscribes lead webhooks. Logged `meta_pages.synced` |

## Bulk actions and the trash (2026-11-11)

`POST /admin/clients/bulk` runs pause, resume, trash, restore or delete on up to 50 clients, one after the other, through the same services (scope checks, audit entries) as each client page; every client gets its own line in the answer. Permissions: pause/resume need subscriptions.manage, trash/restore the new advanced permission clients.trash, delete stays clients.delete (super admins only) and needs `confirm: "DELETE <count>"`.

The **trash** is a temporary delete (`client_trash`, client-archive module): the client disappears from the client and subscription lists, its subscription is paused (services stop, no day lost), nothing is deleted. Its page still opens and says so. Restore removes it from the trash and resumes the pause the trash made (a stop staff set separately stays). `GET /admin/clients/trash` lists it. Delete forever is the archive-then-delete below.

## Team invites (2026-11-11)

Adding a staff member emails them the console link (`ADMIN_CONSOLE_URL`/login) and how to sign in (Google with that address, then the emailed code). The invite carries no code or token. A failed email keeps the member (`inviteSent: false`); `POST /admin/team/:id/invite` sends it again. Logged as team.invite_sent.

## Renewal reminders and Zoho Books (2026-11-11)

`/admin/reminders` (see src/modules/renewal-reminders/README.md) and `/admin/zoho` (see the Zoho Books section of src/modules/billing/README.md). Zoho: billing.view sees status and invoices; billing.manage connects, switches where hotels pay (audit billing.payment_provider_changed), links Zoho customers to clients (suggestions: same email, or the same name without words like Hotel / Resort / Pvt Ltd), applies or sets aside Zoho-made invoices, and makes Zoho invoices for a client.

## Test accounts (2026-11-11)

Dashboards the team makes for testing are kept out of the client and subscription lists. Only the account holder's login email counts (the oldest admin in Zucks_users, the same owner as everywhere else) on `ADMIN_TEST_EMAIL_DOMAINS` (default `eazotel.com,fielmente.com`). A real hotel with an Eazotel team member, or an Eazotel address as its hotel or marketing email, stays a client. `GET /admin/clients?kind=test` and `GET /admin/subscriptions?kind=test` list only test accounts (the console's Test tab); `kind=clients` (default) leaves them out. Read at most once a minute. Both lists' search also matches any login email of an account (3+ characters).

## AI credits (2026-11-11)

`/admin/ai-credits/*`, built on the `ai-credits` module (`../ai-credits/README.md`; whole flow in `docs/AI-CREDITS.md`). Wallets, prices, packages and settings are gian's collections; changes go through the same transaction and audit rows gian's own admin code writes, and are also logged here.

| Permission | Who | Routes |
|---|---|---|
| `credits.view` (base) | every admin, assigned clients only | `GET /clients`, `GET /clients/:ndid` (wallet + 30-day usage), `GET /clients/:ndid/transactions` |
| `credits.manage` (advanced) | given by a super admin, assigned clients only | `POST /clients/:ndid/adjust` (`idempotencyKey` per click), `PUT /clients/:ndid/status`, `POST /clients/bulk-grant` |
| `credits.pricing` (advanced) | company-wide numbers | `GET /overview`, `/openai/topups`, `/openai/costs`, `POST /openai/sync`, `/pricing`, `/packages`, `/settings`, `GET /audit` (gian's aiadminauditlogs) |

Audit actions: `credits.granted`, `credits.deducted`, `credits.wallet_suspended`, `credits.wallet_resumed`, `credits.bulk_granted`, `credits.pricing_changed`, `credits.package_changed`, `credits.settings_changed`, `credits.openai_topup_added`, `credits.openai_topup_edited`. A replayed adjust (same key) is not logged twice. Price changes reach gian's AI requests within 30 s (gian's cache), shown as `appliesWithinSeconds`.

## Status and next steps (keep this updated)

**Built, tested, not committed or deployed yet (2026-11-06):** login (Google + emailed code), team, activity log, clients (list, view, edit, scope by assigned properties), open account, service switches (chatbot, leads) with held leads, lead alerts per property, subscriptions (pause, resume, renew, expire, change plan), add-on apps, client deletion with archive, billing (plans, apps, cycles, offers, payments, revenue). `npm test` in gian-new: 185 tests, all passing (incl. invoices).

**Already shipped elsewhere:**
- gian reads the switches (`src/services/clientServices.service.ts`, `src/services/alertSettings.ts`): committed and pushed to `main` on 2026-11-05. Check that Render has deployed it.
- dashboard-new opens staff sessions at `/staff-access` and locks the dashboard for a paused or ended subscription: committed and pushed on `dashboard-v-2` (2026-11-05).

**How leads are held (decided 2026-11-05):** a held lead keeps its real `ndid` and `hid` and gets `heldAt`. See `../client-services/README.md`.

**Next, in order:**
1. Commit gian-new and the admin console, then deploy both (gian-new needs a mail server: `MAIL_SMTP_*`).
2. Move nexon's chatbot and website-lead paths (`/eazotel/addcontacts`, `/leadeazbot/*`, `/eazotel/get-all-contact-queries`) into a gian-new `crm` module that obeys the switches, then cut them over at nginx.
3. Review the "Ended" subscriptions list, then confirm `CLIENT_SERVICES_FOLLOW_EXPIRY` (default `true`) in gian-new and gian.
4. Credits, more client services, the hotel email-change flow, a restore button for deleted clients.
5. Hotel dashboard work on gian-new (after the admin console).
