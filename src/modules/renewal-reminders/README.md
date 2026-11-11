# renewal-reminders

Reminds hotels by email and WhatsApp that their plan is ending, on the end day, and after it for hotels that forgot to renew. Built 2026-11-11.

- **Schedule** (`reminder_settings` `_id: "default"`, edited in the admin console under Billing → Reminders): off by default, so a deploy never starts messaging hotels by itself. Days before (default 7, 3, 1), the end day, days after (1, 3, 7), from `sendHourIst` (10:00 India time), email and/or WhatsApp, trials included or not, the renew link.
- **Who:** `SubscriptionsPort.endingBetween` → skipped when staff stopped them (paused, expired by hand, in the trash), cancelled, or with auto-renew on before the end (auto-renew charges them; if that fails they still get the after-end ones). Renewing moves the end date, which ends the series.
- **Once only:** each reminder's key (`ndid:endDay:offset`) is claimed in `reminder_log` (unique index) before anything is sent, so the 15-minute scheduler, restarts or a second server never repeat one. Each row keeps how email and WhatsApp went.
- **Email** to the hotel email and the account holder (`MailerFactory`'s mailer). **WhatsApp** from Eazotel's own number (`src/integrations/whatsapp`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`) with an approved Utility template (default name `subscription_reminder`, language `en`) whose body takes 4 values: hotel, plan, when, renew link. The console shows the exact body to submit to Meta. No number on the server = email only, and the log says why.
- **By hand:** `POST /admin/reminders/send` (subscriptions.manage) reminds up to 50 clients now, whatever the schedule; the client list's bulk bar uses it.

Admin routes: `/api/v1/admin/reminders` (overview, `PUT /settings`, `/upcoming`, `/log`, `/send`) in the admin module. Tests: `__tests__/renewal-reminders.test.ts`, `admin/__tests__/admin-reminders.http.test.ts`.
