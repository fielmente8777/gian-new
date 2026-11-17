# newsletter

The hotel's newsletter list, the newsletter box on its website, the welcome email, and the
unsubscribe link in every newsletter and campaign email. The dashboard's **Marketing → Newsletter**
page uses it. Sending a newsletter goes through gian's email marketing (campaigns, open/click stats).

## Where the data lives

| Collection | Owner | What |
| --- | --- | --- |
| `Newsletters` | shared with nexon | one row per client (`ndid`) and address |
| `newsletter_settings` | this module | welcome email + "new subscriber" alert, `_id` = ndid |

nexon's `/editnewsletter` inserts only `{ ndid, email }`. Every other field is optional and read
with a default: no `status` = subscribed, no `source` = website, no `subscribedAt` = the time in
the `_id`. Rows written here also carry `name`, `tags`, `unsubscribedAt`, `unsubscribedBy`
(`subscriber` | `hotel`) and `unsubscribeReason`.

The list is per client, not per property: the website box only knows the website's domain.

## The one rule

Someone who unsubscribed **themselves** is never signed up again by the hotel: not by hand
(`SUBSCRIBER_OPTED_OUT`), not by an import (counted as `skippedUnsubscribed`), not by
"resubscribe" (skipped). Only they can, from the website box. An unsubscribe the hotel made
can be undone by the hotel.

Someone who unsubscribes from a campaign without being on the list is added as
`unsubscribed` with source `campaign`, so gian never emails them again.

## Routes

Dashboard (`/api/v1/newsletter`, dashboard token): `GET subscribers`, `GET subscribers/export`
(CSV), `POST subscribers`, `POST subscribers/import`, `POST subscribers/bulk`,
`PATCH subscribers/:id`, `GET stats`, `GET tags`, `GET audience` (addresses to send to),
`GET|PUT settings`.

Public, open CORS (any hotel domain), mounted at the root:

- `POST /newsletter/subscribe { site, email, name? }`: the website box (10 a minute per visitor)
- `POST /editnewsletter { Domain, email }`: nexon's path, same answer as nexon (`{ Status, Message }`,
  always 200). Gets traffic once nginx sends it here; the websites need no change.
- `GET /newsletter/unsubscribe?t=`: confirm page only. Mail scanners open every link, so a GET
  never unsubscribes anyone.
- `POST /newsletter/unsubscribe?t=`: the confirm button, and mail apps' one-click unsubscribe
  (RFC 8058, `List-Unsubscribe-Post`).

## Unsubscribe links

`UnsubscribeLinks` signs `[ndid, email]` with `NEWSLETTER_UNSUBSCRIBE_SECRET` (HMAC-SHA256).
gian's campaign sender builds the same tokens (`gian/src/utils/newsletterUnsubscribe.ts`) with the
same secret, adds the link and `List-Unsubscribe` headers to each email, and skips addresses that
are `unsubscribed` here. Without the secret, emails go out with no link and the dashboard says so.

## Emails

On a new website signup (not for "already subscribed"): the welcome email to the guest (if on;
`{{name}}`, `{{hotel}}` filled in, with the unsubscribe link) and the alert to the hotel email and
the account owner (if on). Neither goes out while the hotel's subscription has ended or is paused
(`SubscriptionRule.serving`, same as client-services); the signup is still saved. A failed email
never fails the signup.

## Going live

1. `npm run newsletter:migrate` (dry run), then `-- --apply`: lower-cases emails, merges duplicate
   rows (an opt-out wins), builds the unique `{ ndid, email }` index. Until then the module starts
   with a warning and a non-unique index.
2. Set `NEWSLETTER_UNSUBSCRIBE_SECRET` here and in gian (same value), and gian's
   `NEWSLETTER_UNSUBSCRIBE_URL` to `<PUBLIC_URL>/newsletter/unsubscribe`.
3. nginx: send `POST /editnewsletter`, `/newsletter/subscribe` and `/newsletter/unsubscribe` to gian-new.

## Tests

`__tests__/newsletter.test.ts` (in memory). `__tests__/newsletter.mongo.test.ts` runs the
repositories against a local mongod when `NEWSLETTER_TEST_MONGO_URI` is set (see the file).
