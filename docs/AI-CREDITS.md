# AI credits

How Eazotel resells its OpenAI (and other AI provider) usage to hotels as credits, and how staff
run it from the admin console. Written 2026-11-11.

## The idea

Eazotel pays every AI provider from one company account. Hotels never see tokens or dollars: they
hold **credits** in a wallet. Each AI feature (website chatbot, WhatsApp replies, knowledge base,
email templates, review replies) costs credits worked out from what the provider charged us, with
our margin built in. When a wallet is empty the hotel's AI pauses until it recharges.

## The flow

```
hotel uses an AI feature
   │
   ▼
gian ── holds credits ──► calls OpenAI/Anthropic/Sarvam/Groq ──► reads the usage it reports
   │                                                                  │
   │  cost  = tokens × price per 1M (aipricings)                      │
   │  credits = ceil(cost × creditConversionRate), min 1 per call  ◄──┘
   ▼
settles: wallet −credits, ledger row (aicredittransactions), usage row (aiusagelogs)
   │
   ├── wallet low / empty ──► dashboard banner, AI paused ──► hotel recharges (Razorpay, gian)
   │                                                            └─► package credits added
   ▼
admin console (gian-new)
   ├── clients: wallets, usage, ledger; add/remove credits, suspend, bulk grant
   ├── pricing / packages / settings (gian's collections, same audit rows as gian)
   └── OpenAI account: daily costs from OpenAI ─► pool = top-ups − spend ─► low-pool email
```

- **gian** does all charging (`gian/src/services/aiCredits/*`). Its `/api/v1/ai-credits` routes for
  the hotel dashboard (wallet, recharge, usage) are unchanged.
- **gian-new** (`src/modules/ai-credits`, routes in `src/modules/admin`) is the staff side.
- **dashboard-new** shows the wallet, recharge and the low-credit banner.

## Credits and margin

`creditConversionRate` on each price row = credits charged per 1 USD of provider cost. With 1000:
one credit is $0.001 of provider cost. What the hotel pays per credit comes from the packages, so:

```
cost per credit (₹)  = 1 / creditConversionRate × USD→INR
sale per credit (₹)  = package price / package credits
margin               = (sale − cost) / sale
```

The console's Pricing screen shows all three for every row (set the USD→INR rate in Settings).
gian caches prices for 30 s, so a change reaches AI requests within 30 s.

## The OpenAI pool

OpenAI has no API for the prepaid credit balance. The console works it out:

```
remaining = sum(top-ups recorded in the console) − OpenAI's cost since the first top-up
runway    = remaining ÷ average daily cost of the last 7 full UTC days
coverage  = remaining ÷ (unused client credits ÷ average credits per USD)
```

Coverage below 1 means that if every hotel used all its credits, the OpenAI balance would not be
enough.

Costs come from OpenAI's Costs API (`GET /v1/organization/costs`, Admin key), synced every 6 hours
(first run: 30 days back; later runs: the last 3 days again, since OpenAI revises recent days).
**Reconciliation** shows, per UTC day, OpenAI's cost next to what gian recorded for its OpenAI calls;
the gap is usage gian didn't record or models without a price row.

Alerts: when remaining < `lowPoolUsd` (default $25) or runway < `lowRunwayDays` (default 5), every
active super admin and any extra address in Settings gets one email per condition per 24 hours.

### How to record an OpenAI top-up

1. **First time:** open platform.openai.com → Billing, note the credit balance shown today.
   In the console, AI credits → OpenAI → **Add top-up**: that amount, today's date, note
   "opening balance". Spend is counted from this day.
2. **Every payment after that:** add a top-up with the amount and the day it reached OpenAI.
3. Wrong amount? Edit it (top-ups are never deleted; edits are logged).
4. Compare once a month: the console's remaining vs OpenAI's billing page. A difference means a
   missed top-up, or spend before the first top-up's date.

Only OpenAI is tracked this way. Anthropic, Sarvam and Groq usage is still charged to wallets
(with their price rows) but has no pool view yet.

## Environment

| Where | Variable | What |
|---|---|---|
| gian-new | `OPENAI_ADMIN_KEY` | OpenAI **Admin** key (`sk-admin-…`, Organization settings → Admin keys). Empty: pool, costs and alerts are off; everything else works |
| gian-new | `ADMIN_CONSOLE_URL` | link in the alert email (already set for the console) |
| gian-new | `MAIL_SMTP_*` | the alert email (already needed by the console) |
| gian (unchanged) | `OPENAI_API_KEY`, `AI_CREDITS_ADMIN_EMAILS`, Razorpay keys | charging and recharge, as today |

## Permissions (admin console)

| Permission | Gives |
|---|---|
| `credits.view` (every admin) | wallets, usage and ledger of their assigned clients |
| `credits.manage` (super admin gives it) | add/remove credits, suspend/resume, bulk grant, assigned clients only |
| `credits.pricing` (super admin gives it) | overview, OpenAI top-ups and costs, pricing, packages, settings, gian's audit |

Every change is in the console's Activity log and in gian's `aiadminauditlogs`.

## Go-live checklist

1. **Prices and packages.** Live `aipricings` and `aicreditpackages` are empty (2026-11-11): every
   call is charged at the fallback rate and hotels have nothing to buy. Check the placeholder
   numbers in `scripts/seed-ai-credits.ts` (provider prices, 1000 credits per $, ₹499/1999/4999
   packs), then `npm run ai-credits:seed` (dry run) and `-- --apply`.
2. **OpenAI Admin key.** Create it, set `OPENAI_ADMIN_KEY` on gian-new's server.
3. **Deploy gian-new** with this module. Its indexes on `ai_provider_cost_daily` and
   `ai_provider_topups` are built at boot; gian's collections are not touched.
4. **Record the opening balance** as the first top-up (above).
5. **Settings:** USD→INR rate, low-pool level, runway days, extra alert emails.
6. **Give permissions:** `credits.manage` / `credits.pricing` to the staff who need them.
7. **Check gian is deployed** with its `/api/v1/ai-credits` routes; the hotel dashboard showed demo
   data because the live route answered 404.
8. **Turn charging on** (Settings → "Charge AI credits") only when testing is done. See below.
9. Decide free starter credits for new hotels (plans already carry `limits.aiCreditsMonthly`, but
   nothing grants them yet).

## The on/off switch

`aicreditsettings.enabled` (console: AI credits → Settings → **Charge AI credits**, needs
`credits.pricing`). A missing field counts as **off**, so charging starts off.

- **Off:** gian's `withAiBilling` runs the AI call with no hold and no charge, `assertAiAvailable`
  never throws 402/403, and `/api/v1/ai-credits/status` answers `paused: false,
  chargingEnabled: false`. Provider calls are still written to `aiprovidercalls` with the hotel's
  ndid, so cost analytics and reconciliation keep working. Wallet balances are not touched.
- **On:** everything is charged as described above; hotels with no credits get AI paused.
- gian reads the setting on every AI request, so a change applies to the next request. Each change
  is in gian's audit log (`settings.update`) and the console's Activity (`credits.settings_changed`).

## Not done yet

- Monthly plan credits (`aiCreditsMonthly`) are not granted automatically.
- No pool view for Anthropic, Sarvam or Groq.
- The hotel dashboard's owner page (`admin/ai-credits` in dashboard-new) still uses gian's
  `AI_CREDITS_ADMIN_EMAILS`; replace it with a link to the console once the console screens are live.
