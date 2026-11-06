# Client services module

The services Eazotel staff can turn off for a client from the admin console: **chatbot** and **leads**. The switches live in `client_services`, one document per client:

```json
{ "ndid": "…", "services": { "leads": { "enabled": false, "changedAt": "…", "changedBy": "staff@eazotel.com" } } }
```

A client without a document, or a service without an entry, is **on**.

## Who obeys the switches

**Which clients are stopped:** paused or expired by staff in the admin console, **or** whose subscription end date has passed or which were cancelled (`CLIENT_SERVICES_FOLLOW_EXPIRY`, on by default; set it to `false` in both gian and gian-new to follow staff actions only). A stopped client gets no lead email, WhatsApp alert, in-app notification or phone/browser push (gian checks in its alert workers, the guest auto-reply and the new-lead notification watcher), and its chatbot is hidden. Its own notification settings don't matter while it is stopped. Renewing turns everything back on and sends one catch-up email.

nexon is being switched off and gets **no** changes: every nexon path is rewritten here (README §8–9). So the switches are obeyed by:

- **gian-new**, in each endpoint as it is ported. The chatbot and lead paths nexon serves today (`/eazotel/addcontacts`, `/leadeazbot/get/dashboard`, `/leadeazbot/chat`, `/leadeazbot/create`) must check them when they move to the `crm` module. Until those paths are cut over at nginx, nexon serves them and **ignores the switches**.
- **gian** (`src/services/clientServices.service.ts`), for the lead webhooks, alerts, auto-reply and AI chat it still runs. It reads `client_services` directly, caches it for 30 seconds, and treats a read error as "on", so a database problem never costs a paying hotel its leads.

Keep `types/client-services.types.ts` and gian's reader in step.

| Switch off | What happens |
|---|---|
| **chatbot** | gian `/eazbot-web/chat` refuses to answer. **To build in gian-new's `crm` module:** `/leadeazbot/get/dashboard` answers `active: false` (plus `servicePaused: true`) so the website widget hides itself, `/leadeazbot/chat` refuses, and `/leadeazbot/create` keeps the hotel's own `active` setting while it's off |
| **leads** | gian saves Meta, Google Ads, WordPress and Webflow leads and their contacts under the hotel's **real** `ndid` and `hid`, with `heldAt` set. gian's lead list skips `heldAt` leads. gian's alert workers send no email or WhatsApp alert, no auto-reply goes to the guest, and the Meta bulk import from the hotel dashboard is refused. **To build in gian-new's `crm` module:** the same for website and chatbot form leads (`/eazotel/addcontacts`) |

**Turning leads back on** removes `heldAt` from every held lead and contact, so they appear in the dashboard (`releasedAt` is set). It runs again 40 seconds later, for leads that arrived while gian still had "off" cached. If any are left, the admin console shows a **Release to hotel** button. Released leads are not emailed afterwards; they just appear in the dashboard.

## Not covered

- Leads the hotel already had stay visible.
- A lead a hotel creates itself from a WhatsApp chat in its dashboard is not held, because it's the hotel's own action. WhatsApp conversations themselves are a separate service.
- Website and chatbot form leads, and hiding the chatbot widget, work only once those nexon paths are served by gian-new.
- gian's part works only once gian is deployed with it.

## How leads are held (decided 2026-11-05)

Every lead always keeps the hotel's real `ndid` and `hid`. While the hotel's leads are stopped, gian saves the lead normally, adds `heldAt`, and writes one line to `pending_lead_alerts` instead of sending the email and WhatsApp alert. gian's lead list skips `heldAt` leads. When the hotel is served again, gian-new removes `heldAt` and sends one catch-up email from `pending_lead_alerts`.

Rejected: replacing the ndid with `withheld:<ndid>`. It put a fake client id in the field every report, duplicate check and export relies on.

**Known gaps until gian-new's `crm` module replaces them:**
- Website and chatbot form leads are saved by nexon, so they never get `heldAt`. Only their alerts are held, by gian.
- nexon's `/eazotel/get-all-contact-queries` doesn't know `heldAt`.

For a paused or expired subscription neither gap matters, because the hotel dashboard shows its renew page and lists nothing. They matter only when the leads switch is off while the subscription is active.
