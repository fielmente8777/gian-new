# Billing module

Plans, prices, offers and payments for hotels. Hotels pay from the dashboard's **/plans** page,
staff manage everything from the admin console's **Billing** screens, and the website's
**/pricing** page shows the same catalogue. One source of truth: change a price in the admin
console and all three follow.

## The catalogue (what Eazotel sells)

| Data | Collection | Edited in |
|---|---|---|
| Plans: price per month, included apps, limits, bullet points, support, visibility | `plans` (gian's, extra fields added) | Admin → Billing → Plans & pricing |
| Add-on apps: name, description, price per month | `apps` (gian's) | same |
| Billing cycles with their discount, GST %, extra seat price, trial days | `billing_settings` (`_id: "default"`) | same |
| Offer codes | `billing_offers` | Admin → Billing → Offers |

Prices in the catalogue are **rupees per month before GST**. Every amount the API computes is
**paise** (₹1 = 100).

**How plans work:**
- A plan **includes** some apps. Any other app can be **added on** at its own monthly price.
- **Extra team seats** cost the seat price each per month, on top of the plan's own seats.
- A **longer cycle** earns its discount on the whole amount (default 3 months −10%, 6 months
  −15%, 12 months −30%).
- **Custom** plans (Enterprise) show "Let's talk", a note and a "Talk to sales" button instead of a price. Staff can reword all three per plan in the admin console. For a deal, staff create a private plan
  (Public off, the agreed price, `visibleTo: [ndid]`). That hotel then sees it on /plans and
  pays for it like any other plan.
- **Archived** plans (`isActive: false`) can't be bought. Hotels already on one keep it until
  their end date.
- `TRIAL` is never sold. gian gives new hotels a 14-day trial on ENTERPRISE with every app on.

The proposed structure (what BASIC / PRO / ENTERPRISE include) is in
`scripts/seed-billing.ts`. Run it once (`npx tsx scripts/seed-billing.ts`, then `--apply`).
It does not change any price.

## Pricing (PriceCalculator, unit-tested)

```text
monthly  = plan + each add-on + extra seats × seat price
gross    = monthly × months
− cycle discount            (e.g. 30% for 12 months)
− offer                     (percent with an optional cap, or rupees)
− credit for unused time    (plan change only)
= taxable;   + GST   = total
```

What kind of purchase it is decides when the new period starts:

| Kind | When | Period |
|---|---|---|
| `new` | no paid plan running: no subscription, trial, ended, or stopped by staff | starts now |
| `renew` | the same plan, add-ons and seats as now | added after the current end, so paying early loses nothing |
| `change` | anything else while paid (upgrade, downgrade, add or drop apps or seats) | starts now; the unused part of the current period is credited |

Credit that's more than the new price (e.g. a downgrade) becomes **bonus days** at the end of
the new period, so it's never lost. A total under ₹1 is waived.

The browser never sends an amount. `/checkout` prices the choice again on the server, and
`expectedTotalPaise` makes it answer `409 PRICE_CHANGED` if the price moved since the hotel looked.

## After a payment (PeriodActivator)

1. The subscription gets the new `planId`, `endDate`, `status: ACTIVE` and `billing` (the paid
   period: terms, dates, value). Any staff stop is cleared.
2. `apps` becomes exactly the plan's apps plus the add-ons bought.
3. In `appAccess`, every catalogue app is set on or off to match, and every core area (`cms`,
   `frontDesk`, `usermanagement`, … see `CORE_FEATURE_KEYS`) is set on. Keys billing doesn't
   know stay as they are. **This is what ends "everything on" after the trial.**
4. The client-services enforcer runs: the chatbot and lead alerts come back, and held leads
   are released with one catch-up email.
5. A receipt email goes to the owner and the hotel email.

A payment is applied **once**, however many times the browser and the webhook report it.
`payments.claim` takes the order atomically; a crash halfway lets the webhook's retry take it
again after 2 minutes.

## Invoices

Every successful payment gets a **GST invoice** (`billing_invoices`), issued once and never changed:

- **Number** per Indian financial year: `<prefix>/26-27/00001`, from an atomic counter (`billing_counters`).
- **Seller**: Eazotel's name, address, state, GSTIN, PAN, SAC code and number prefix, set in
  Admin → Billing → Plans & pricing → **Invoice details**. With a GSTIN it is titled TAX INVOICE.
- **Buyer**: the hotel's own billing details (`billing_profiles`, edited in Settings → Subscription:
  business name, GSTIN, address, state, invoice email), filled from its profile until saved.
- **Tax**: CGST + SGST (half the rate each) when Eazotel and the hotel are in the same state, else IGST.
- **Lines**: the plan, each add-on and extra seats (months × monthly rate), then the cycle discount,
  offer and credit, taxable value, tax, total and the amount in words. Auto-renewals and payments from
  gian's older checkout show one line, worked back from the amount paid.
- **PDF**: drawn by `shared/pdf/pdf-document.ts` (no dependency; the PDF's built-in fonts, so "₹" prints as "INR"/"Rs.").

The receipt email carries the PDF. Hotels download every invoice from Settings → Subscription
(`GET /billing/invoices/:id/pdf`, own invoices only). Staff download it, email it to any address, or
create one for an older paid payment (`/admin/billing/invoices/*`, `/admin/billing/payments/:orderId/invoice`).

A hotel that changes its GSTIN gets it on the next invoice; issued invoices stay as they were (a GST rule).

## Auto-renew

A Razorpay **subscription** (a card or UPI AutoPay mandate) for the renewal price (cycle discount,
GST, no offer, no credit), first charged at the current end date. The hotel turns it on after
paying, or later in Settings → Subscription, and authorises it once in Razorpay's window.
Razorpay's authorisation window takes a small **refundable** amount (such as ₹5) to check the card or UPI; that is not a plan payment, and the dashboard says so before opening it (the window never opens by itself after paying). Razorpay charges each period and sends `subscription.charged`; we record the payment
(`kind: auto_renew`) and add the period. Turning it off cancels it at Razorpay.

The amount is fixed when the mandate is set up. After a price change, existing mandates keep
their amount until the hotel turns auto-renew off and on again.

Needs **Subscriptions enabled** on the Razorpay account and the webhook below.

## Routes

Hotel (dashboard token; old nexon tokens work):

| Route | What it does |
|---|---|
| `GET /api/v1/billing/catalogue` | public: what the website shows |
| `GET /api/v1/billing/account` | phase, plan, current terms, apps on, limits, plans it can buy, last 25 payments |
| `POST /api/v1/billing/quote` | price a choice |
| `POST /api/v1/billing/checkout` | Razorpay order for the server's price (owner only) |
| `POST /api/v1/billing/checkout/confirm` | Razorpay's handler result → verify → apply |
| `POST /api/v1/billing/auto-renew` `{ enabled }` | on: a mandate to authorise; off: cancel |
| `POST /api/v1/billing/auto-renew/confirm` | Razorpay's result after authorising |
| `GET /api/v1/billing/invoices/:id/pdf` | download one of the hotel's invoices |
| `GET` / `PUT /api/v1/billing/details` | the name, GSTIN and address on its invoices (saving: owner only) |
| `POST /api/v1/billing/webhooks/razorpay` | Razorpay → us, signed |

Staff: `/api/v1/admin/billing/*`, see `../admin/README.md` (permissions `billing.view`, `billing.manage`).

## Setup

| Env | Where |
|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay → Account & Settings → API keys (`rzp_test_…` to test) |
| `RAZORPAY_WEBHOOK_SECRET` | the secret you type when adding the webhook |

Webhook URL: `<PUBLIC_URL>/api/v1/billing/webhooks/razorpay`. Events: `payment.captured`,
`payment.failed`, `order.paid`, `subscription.authenticated`, `subscription.activated`,
`subscription.charged`, `subscription.halted`, `subscription.paused`, `subscription.resumed`,
`subscription.cancelled`, `subscription.completed`.

`CORS_ORIGINS` must list the dashboard's and the website's origins.

Step-by-step testing: `docs/BILLING-TESTING.md`.

## Shared with gian

gian's old `/api/v1/subscription/create-order` and `/verify-payment` still exist and write the
same `payments` collection. Nothing calls them after this ships; they can be retired.
gian's `/subscription/my` reads the same subscription document, so the lock screen and the menu
follow a payment made here.

## Not built yet

- (Renewal reminders: built 2026-11-11 in `modules/renewal-reminders`, email + WhatsApp.)
- Credit notes for refunds (refunds themselves are done in Razorpay's dashboard).
- Refunds (done in Razorpay's dashboard by hand).
- Enforcing team-member and property limits (shown on the plans and subscription pages).

## Zoho Books (added 2026-11-11)

A second way to pay, for the team that already invoices in Zoho Books. Razorpay stays the default; nothing changes until a super admin flips the switch.

**Switch** (`zoho_connection` `_id: "payment_setup"`, admin `PUT /admin/zoho/provider`): `razorpay` (default) or `zoho`. With `zoho`, `POST /billing/checkout` answers `status: "invoice"`: a Zoho invoice made from the same server quote (lines for the whole period, the cycle discount + offer + credit as one discount before tax, the GST tax chosen in the console), marked sent, with its payment page in `invoiceUrl`. Auto-renew can't be turned on meanwhile; existing Razorpay mandates keep charging. If Zoho isn't configured on a server, checkout ignores the saved switch and stays on Razorpay. Disconnecting while on Zoho puts the switch back on Razorpay.

**Getting paid:** our order id (`zinv_…`) is the invoice's reference number and is stored in `zoho_invoices`. Zoho's workflow webhook (`POST /billing/webhooks/zoho?token=ZOHO_WEBHOOK_TOKEN`, body `{"invoice_id": "..."}`) and a check every 30 minutes (`ZohoPoller`, paid invoices most recently changed first) read the invoice back from Zoho's API, never trusting the body, and call the same `CheckoutService.applyPaid` as Razorpay: once only. We don't issue our own GST invoice for a Zoho payment; Zoho's is the invoice.

**Invoices the team makes in Zoho Books** land in `zoho_invoices` with `source: "zoho"`. The client comes from `zoho_customer_links` (one Zoho customer ↔ one ndid, linked in the console with name/email suggestions). Staff confirm the plan and months (prefilled from the current plan and the amount); `ZohoSyncService.apply` records a payment (`zoho_<invoiceId>`, method `zoho`) and runs `PeriodActivator`: same plan = after the current end, another plan = from today. An invoice that isn't for a plan can be set aside.

**Staff invoices:** `POST /admin/zoho/clients/:ndid/invoice` makes a Zoho invoice for a client at dashboard prices whichever way the switch is, and Zoho can email it.

**Connection:** one OAuth connection for Eazotel's organisation (`ZohoConnectionService`): a one-time `state` in `zoho_oauth_states` (10 minutes, TTL index), the refresh token AES-256-GCM encrypted with `ZOHO_TOKEN_KEY` (`TokenCipher`), access tokens refreshed when they expire. Env: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_ACCOUNTS_URL`, `ZOHO_API_URL` (India data centre by default), `ZOHO_TOKEN_KEY`, `ZOHO_WEBHOOK_TOKEN`. Redirect URI: `<PUBLIC_URL>/api/v1/billing/zoho/callback`. Client: `src/integrations/zoho/zoho-books.client.ts` (fetch + zod, no SDK). Tests: `__tests__/zoho.test.ts` over `FakeZohoBooks`.
