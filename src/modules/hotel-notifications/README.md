# hotel-notifications

How each property hears about a new lead: an email, a WhatsApp message, both or neither, set
separately for each lead source. These are the same settings the hotel edits in its dashboard
(Settings → Notifications). gian reads them for every lead. Eazotel staff edit them from the
admin console (`/admin/clients/:ndid/notifications`).

## Data

`hotelnotifications`, owned by gian (`src/models/EmailConfig.model.ts`). One document per
property (ndid + hid):

```
{ ndid, hid,
  config: { webform | eazbot | whatsapp | facebook | google:
            { isEmailAllowed, email[], isPhoneAllowed, phone[], _id } },
  callConfig }            // WhatsApp call replies: never touched here
```

| source     | leads from                                         |
| ---------- | -------------------------------------------------- |
| `webform`  | website forms: WordPress, Webflow, Eazotel sites   |
| `eazbot`   | the chatbot                                        |
| `whatsapp` | guests writing to the hotel on WhatsApp            |
| `facebook` | Meta (Facebook / Instagram) lead ads               |
| `google`   | Google Ads lead forms                              |

The API calls these `email`, `emails`, `whatsapp` and `phones`. Saving writes all five sources
and keeps each subdocument's `_id` and the rest of the document. Phone numbers are saved as
gian sends them: digits with the country code (a 10-digit number gets `91`).

## What gian does with them

- **Email**: sent only when `isEmailAllowed` is true, to the hotel's email plus `email[]`.
- **WhatsApp**: sent to the hotel's phone, plus `phone[]` while `isPhoneAllowed` is true.
  Nothing is sent when `isPhoneAllowed` is saved as false (gian `AlertSettings`; before
  2026-11-05 gian ignored this switch).
- A property that never saved settings: no email, WhatsApp to the hotel's phone.

These sit below the master switches in client-services. While a client's Leads switch is off,
or its subscription is paused, expired or has ended, no alert goes out whatever these say. The
admin console shows that as `leadsDelivered: false`.
