# meta-pages

Facebook pages from every sign-in with Meta, and which client each page's leads belong to.
Staff see and change this from the admin console (**Meta pages** screen, `/api/v1/admin/meta-pages`).
This module has no routes of its own.

## Where the data lives

`pageconnections` is gian's collection (`gian/src/models/PageConnection.model.ts`). gian writes
one document when someone signs in with Meta from the hotel dashboard, keyed by the client that
started the sign-in (`ndid`, `hid`), holding the Meta user token (`longLivedToken`) and every page
the person granted (`pages[]`, each with its own page token).

Each page entry also carries `ndid` and `hid`. **Those two fields decide whose lead it is**: gian's
lead webhook (`gian/src/services/leadgen.service.ts`) finds the document that has the page, reads
the page's `ndid`/`hid` and saves the lead to `ContactUs` under them. A page without them has its
leads saved with no client, so nobody sees them.

## Why links are written to every copy

The agency (Eazotel) signs in with Meta once and gets ~30 client pages; hotels sometimes sign in
too. So one page sits in several documents. A link is therefore written to the page in **every**
document that has it (`updateMany` with an array filter), so whichever copy the webhook reads, it
finds the same client. The page list marks `conflict` when copies point at different clients
(fixed by linking the page again).

## Sync

`sync(connectionId)` calls Meta's `/me/accounts` with the document's user token and merges:

- pages already there: name, page token, category, picture and Instagram refreshed; the link kept
- new pages: added, with the link the page already has in another document (if any)
- pages Meta no longer returns: kept as they are, reported as `missing`

Then every returned page is subscribed to `leadgen` webhooks (as gian does after a sign-in; Meta
ignores repeats). Meta's errors (an expired or revoked token) come back as `META_SYNC_FAILED`;
a document without a token as `META_TOKEN_MISSING`. A new sign-in still has to happen from the
hotel dashboard (gian's `/api/v1/auth/meta/start`), because Meta's sign-in redirects there.

Tokens never leave this module.
