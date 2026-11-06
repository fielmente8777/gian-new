# Testing plans, payments and auto-renew

Step by step, from setup to every case worth checking. Use **Razorpay test keys** throughout:
no real money moves. Each test lists what you should see.

Projects involved:
- **gian-new** (backend): `d:\eazotel-work\gian-new`
- **admin console**: `d:\eazotel-work\admindashboard`
- **hotel dashboard**: `d:\eazotel-work\dashboard-new`
- **website**: `d:\eazotel-work\Eazotel-website-2026`

---

## 1. Setup

### 1.1 Pick a database

A payment rewrites the hotel's subscription, so be deliberate about which database you use.

- **Option A, safest:** a copy. Start Docker (`docker compose up -d mongo`, port 27018), copy
  `plans`, `apps`, and one test hotel's `Zucks_users`, `Zucks_profile` and `subscriptions`
  documents into it, and set `MONGO_URI=mongodb://localhost:27018` in gian-new's `.env`.
- **Option B:** the live database with a **test hotel account** only (for example the test
  account `sk7627577@gmail.com`). Only that hotel's subscription and payments change. Run the
  seed (1.3) only once you're happy with the plan structure, because the website shows it.

### 1.2 Razorpay (test mode)

1. Razorpay dashboard → switch to **Test mode** → Account & Settings → **API keys** → generate.
2. Settings → **Subscriptions**: make sure it's enabled (needed for auto-renew).
3. In gian-new `.env`:
   ```env
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxx
   RAZORPAY_WEBHOOK_SECRET=any-long-random-text
   CORS_ORIGINS=http://localhost:5173,http://localhost:3000,http://localhost:3001
   ```
4. **Webhook** (for tests 5.x and 7.x): expose gian-new with `ngrok http 8000`, then Razorpay →
   Webhooks → Add: URL `https://<ngrok-id>.ngrok-free.app/api/v1/billing/webhooks/razorpay`, the
   same secret, and the events listed in `src/modules/billing/README.md`.

### 1.3 Seed the plan structure

```bash
cd gian-new
npx tsx scripts/seed-billing.ts            # shows what would change, writes nothing
npx tsx scripts/seed-billing.ts --apply    # writes it (prices are never changed)
```

You should see: BASIC includes Lead Management + website/WordPress forms; PRO adds WhatsApp,
Eazbot and Meta leads; ENTERPRISE includes everything as "Contact sales"; cycles monthly 0%,
quarterly −10%, half-yearly −15%, yearly −30%.

### 1.4 Start everything

| Project | Command | Env |
|---|---|---|
| gian-new | `npm run dev` (port 8000) | as above; `npm test` should say 185 passing |
| admin console | `npm run dev` (port 3000) | `NEXT_PUBLIC_API_URL=http://localhost:8000` |
| dashboard | `npm run dev` (port 5173) | `VITE_APP_API_URL=http://localhost:8000` |
| website | `npm run dev -- -p 3001` | `NEXT_PUBLIC_EAZOTEL_API_URL=http://localhost:8000` |

Your staff account needs `billing.view` and `billing.manage`. A super admin has both.

---

## 2. Admin console: plans and prices

| # | Do | Expect |
|---|---|---|
| 2.1 | Open **Billing** in the sidebar | Three tabs: Overview & payments, Plans & pricing, Offers |
| 2.2 | Sign in as an admin without billing permissions | No Billing in the sidebar; `/billing` says you don't have access |
| 2.3 | Team → edit that admin → tick **View billing** | They can see Billing but every Edit / New button is hidden |
| 2.4 | Plans & pricing → edit **PRO** → price 1199 → Save | Card shows ₹1,199; Activity shows `billing.plan_updated` with 999 → 1199 |
| 2.5 | Edit PRO → tick Exotel under Included apps → Save | Exotel shows "Included in Pro" in the apps table |
| 2.6 | Edit an app's price (e.g. Eazbot 500 → 600) | Apps table updates; Activity logs it |
| 2.7 | Settings: set yearly discount to 25% → Save | Saved; website and dashboard show −25% for yearly |
| 2.8 | Add two cycles with the same months → Save | Refused: "Each cycle needs a different number of months" |
| 2.9 | **New plan** (private enterprise deal): code `ENT_TEST`, price 4999, Public off, Custom on, your test hotel's ndid under "Only for these hotels" | Card shows "Private · 1 hotel(s)" and "Contact sales" |
| 2.10 | Offers → **New offer** `WELCOME20`, 20%, Renewals unticked, Uses per hotel 1, Show on pricing pages on | Listed as **Live** |
| 2.11 | New offer with 150% | Refused: "A percent offer is at most 100" |
| 2.12 | Plans & pricing → **Invoice details**: company name, address, state, GSTIN, PAN, SAC, prefix `EZ` → Save | Saved; the orange "add the GSTIN…" note disappears |
| 2.13 | Type a GSTIN with 10 characters | Refused: "A GSTIN has 15 characters…" |

Put prices back (999, 500, 30%) when you're done, or keep them if they're right.

---

## 3. Website pricing page

| # | Do | Expect |
|---|---|---|
| 3.1 | Open `http://localhost:3001/pricing/` | BASIC, PRO, ENTERPRISE from the catalogue; PRO marked Most popular; offer banner `WELCOME20` |
| 3.2 | Switch Monthly / Yearly | Monthly prices drop by the cycle discount; the original price is struck through |
| 3.3 | Look at "Compare plans" | Included apps ticked; others show "+ ₹500/mo" etc. |
| 3.4 | Click "Already with Eazotel? Buy…" on PRO | Opens the dashboard's `/plans?plan=PRO&cycle=12` |
| 3.5 | Stop gian-new and reload | Still shows plans (from gian's old endpoint) instead of an empty page |

---

## 4. Hotel dashboard: trial and app access

Sign in to the dashboard as the test hotel (owner account).

| # | Do | Expect |
|---|---|---|
| 4.1 | Settings → **Subscription** | "Free trial", days left, every app **On** labelled "Free trial", no payments |
| 4.2 | Click **Choose a plan** | `/plans` opens with PRO yearly pre-selected (or the plan from the URL) |
| 4.3 | Change plan, cycle, add Exotel, add 2 seats | Order summary updates after each click; every amount comes from the server |
| 4.4 | Pick ENTERPRISE | "Talk to sales" (no price, can't pay) |
| 4.5 | Sign in as a **team member** (not owner) and open `/plans` | "Only the account owner can pay"; no Pay button |

---

## 5. Paying

Razorpay test checkout: use UPI ID **`success@razorpay`** to succeed and **`failure@razorpay`** to
fail, or a test card from Razorpay's docs (Payments → Test card details).

| # | Do | Expect |
|---|---|---|
| 5.1 | PRO, yearly, + Exotel → **Pay** → pay with `success@razorpay` | "You're all set" with valid until about a year from today; receipt email (or the log in development) |
| 5.2 | Settings → Subscription | PRO, billed every year, 1 add-on; apps: PRO's apps + Exotel **On**, everything else "Not in your plan" with **Add** |
| 5.3 | Look at the sidebar | Apps you didn't buy are gone (e.g. Calls if Exotel wasn't bought, Booking Engine, Guest requests) |
| 5.4 | Type the URL of a page you didn't buy (e.g. `/dashboard/client/<hid>/booking-engine`) | "Booking Engine isn't in your plan" with **See plans and add-ons** |
| 5.5 | Admin → Billing → Overview | Revenue this month includes it; Paying hotels +1; the payment at the top, **Paid**, "PRO · 12 mo · +1 apps · New plan" |
| 5.6 | Admin → the hotel's client page | **Plan payments** card lists it |
| 5.7 | Pay again with `failure@razorpay`, then close the window | Error under the button with Razorpay's reason; the payment shows **Failed** in admin (needs the webhook) |
| 5.8 | Open checkout and just close it | Nothing changes, no error |
| 5.9 | **Closed tab:** start paying, complete the payment, and close the browser tab before the success screen | The webhook applies it: subscription updated within seconds; admin shows Paid (needs the webhook) |
| 5.10 | In admin, change PRO's price while the hotel has `/plans` open, then the hotel clicks Pay | "The price changed. Please check the new total and pay again." and the summary refreshes |

---

### Invoices

| # | Do | Expect |
|---|---|---|
| 5.11 | After 5.1, look at the success screen | **Download invoice EZ/26-27/0000N**; the PDF shows TAX INVOICE, both GSTINs, the plan, add-ons and seats per month, the yearly discount, taxable value, GST and the total |
| 5.12 | The hotel's state is the same as Eazotel's | GST split into CGST 9% + SGST 9%; a different state shows IGST 18% |
| 5.13 | Check the receipt email (or gian-new's log in development) | "Invoice: EZ/…" with the PDF attached |
| 5.14 | Settings → Subscription → Payments | An **Invoice** column; clicking the number downloads the PDF |
| 5.15 | Settings → Subscription → **Billing details for invoices**: business name, GSTIN, state → Save; then pay again | The new invoice shows the new name and GSTIN; the older invoice is unchanged |
| 5.16 | Admin → Billing → payments: **Email** on an invoice → pick an address, add another → Send | Both receive the PDF; Activity logs `billing.invoice_emailed` |
| 5.17 | Admin: an old payment (gian's checkout) shows **Create invoice** → click | An invoice number appears; download and email work |
| 5.18 | Open another hotel's invoice URL with your token | 404 "Invoice not found" |

## 6. Renew, upgrade, downgrade, offers

| # | Do | Expect |
|---|---|---|
| 6.1 | Open `/plans` again without changing anything | Summary says **Renewal**: added after your current end date; no credit |
| 6.2 | Type `WELCOME20` → Apply | "Welcome… applied", 20% off shown |
| 6.3 | Pay | End date moves one more year **from the old end date** (no days lost) |
| 6.4 | Type `WELCOME20` again | "You have already used this code." |
| 6.5 | Remove Exotel (keep PRO yearly) | Summary says the new plan starts today; **Credit for unused time** covers it; total ₹0; "incl. N bonus days" |
| 6.6 | Click **Switch plan now** | Applied at once, no Razorpay window; Exotel is off; end date extended by the bonus days |
| 6.7 | Upgrade BASIC → PRO mid-period | Credit for the unused BASIC time taken off the PRO price |
| 6.8 | Private plan from 2.9 | Only the listed hotel sees "Ent_test ₹4,999" on `/plans` and can pay; other hotels don't see it |

---

## 7. Auto-renew

| # | Do | Expect |
|---|---|---|
| 7.1 | On `/plans`, tick **Auto-renew** and pay | The success screen shows "One more step: turn on auto-renew", explaining the small refundable check. Nothing opens by itself |
| 7.1b | Click **Set up auto-renew** | Razorpay's window shows "a refundable amount of ₹5 will be charged now… then ₹X every month": that is Razorpay checking the card/UPI, refunded, not a plan payment. After authorising: "Auto-renew is on" |
| 7.2 | Settings → Subscription | Auto-renew **on**: "Renews by itself on <end date> for ₹…" |
| 7.3 | Razorpay dashboard → Subscriptions | A subscription starting at the plan's end date |
| 7.4 | Simulate the renewal charge (below) | End date +1 cycle; a payment "Auto-renewal" in admin with its own invoice; receipt "renewed automatically" with the PDF |
| 7.5 | Send the same charge again | Nothing changes (no double renewal) |
| 7.6 | Turn auto-renew **off** in Settings | Off; the Razorpay subscription shows **cancelled** |
| 7.7 | Turn it on from Settings (not during payment) | A dialog explains the ₹5 refundable check first; **Continue to Razorpay** opens the window; then on |

Razorpay's first real charge happens at the end date, so simulate it locally with a signed
webhook (Git Bash; fill in the three values from Settings / the database):

```bash
SECRET='any-long-random-text'          # RAZORPAY_WEBHOOK_SECRET
SUB='sub_XXXXXXXX'                     # subscriptions.autoRenewal.gatewaySubscriptionId
NDID='the-hotel-ndid'
BODY=$(printf '{"event":"subscription.charged","payload":{"subscription":{"entity":{"id":"%s","notes":{"ndid":"%s"}}},"payment":{"entity":{"id":"pay_sim_%s","order_id":"order_sim_%s","amount":990209,"method":"upi"}}}}' "$SUB" "$NDID" "$RANDOM" "$RANDOM")
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -s -X POST http://localhost:8000/api/v1/billing/webhooks/razorpay \
  -H "content-type: application/json" -H "x-razorpay-signature: $SIG" --data "$BODY"
```

For test 7.5, send the same `$BODY` and `$SIG` again (don't regenerate them).

---

## 8. Locked dashboard and staff

| # | Do | Expect |
|---|---|---|
| 8.1 | Admin → Subscriptions → **Expire** the test hotel | Dashboard shows the lock screen |
| 8.2 | Lock screen → **Renew subscription** | Opens `/plans`; paying unlocks the dashboard at once; held leads are released (one catch-up email) |
| 8.3 | Admin → client → **Open account**, then open `/plans` there | Staff can pay on the hotel's behalf (the payment is recorded under the owner's email, because Open account uses the owner's token; the opening itself is in the admin Activity log) |

---

## 9. Automated checks

```bash
cd gian-new && npm test                  # 185 tests (incl. invoices): pricing, offers, planner, checkout, webhook, auto-renew, admin billing
cd admindashboard && npx tsc --noEmit && npx eslint components/billing
cd dashboard-new && npx vite build
cd Eazotel-website-2026 && npx tsc --noEmit
```

## If something goes wrong

| You see | Why | Fix |
|---|---|---|
| "Online payment is being set up" on /plans | `RAZORPAY_KEY_ID` / `SECRET` empty | set them, restart gian-new |
| Plans page: "Could not load the plans" | dashboard can't reach gian-new, or CORS | check `VITE_APP_API_URL`, and that gian-new's `CORS_ORIGINS` lists the dashboard's origin |
| Signed out right after opening /plans | gian-new rejected the token (401) | `AUTH_LEGACY_JWT_SECRET` must equal gian's `JWT_SECRET` |
| Webhook answers 503 | `RAZORPAY_WEBHOOK_SECRET` empty | set it |
| Webhook answers 400 WEBHOOK_SIGNATURE_INVALID | the secret differs from Razorpay's | type the same secret in both |
| Auto-renew: "Your plan ends too soon" | less than an hour left | renew first, then turn it on |
| Sidebar still shows every app after paying | the old session cached the subscription | reload the page |
