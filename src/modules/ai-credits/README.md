# ai-credits

Client AI wallets and the company OpenAI account, for the admin console (**AI credits** screens,
`/api/v1/admin/ai-credits`, routes in the admin module). This module has no routes of its own.
The full flow, env vars and go-live steps are in `docs/AI-CREDITS.md`.

## Two halves

**Client wallets: gian's collections.** gian charges every AI call (`gian/src/services/aiCredits/*`):
it holds credits before a request, settles the real cost after, and writes the ledger. This module
reads those collections and makes staff changes (add/remove credits, suspend, prices, packages,
settings) with gian's own rules, so a change from the console looks exactly like one from gian's
dashboard owner page.

| Collection (gian) | What | Here |
|---|---|---|
| `aiwallets` | one wallet per client (`tenantId` = ndid) | read, staff adjust / suspend |
| `aicredittransactions` | the ledger, one row per balance change | read, adjustment rows |
| `aiusagelogs` | credits charged per AI operation | read (usage, billed cost) |
| `aiprovidercalls` | every provider call | read (tracked cost) |
| `aipricings` | price per provider + model | read / write |
| `aicreditpackages` | recharge packs the dashboard sells | read / write |
| `aicreditsettings` | one doc, `key: "global"` | read / write |
| `aiadminauditlogs` | gian's admin audit | read, and one row per staff change |
| `aicreditreservations`, `airechargeorders` | holds, Razorpay orders | not used here |

`models/gian-ai-credits.models.ts` is a copy of gian's schemas with the collection names pinned and
`autoIndex` off (gian builds indexes). `__tests__/ai-credits.schema-drift.test.ts` fails when gian's
`src/models/aiCredits.model.ts` and the copy disagree: **when gian changes a schema, copy it here**.

**The OpenAI account: gian-new's own collections.** OpenAI has no API for the prepaid balance, so:

```
remaining = sum(top-ups staff recorded) - OpenAI's reported cost since the first top-up
```

| Collection (gian-new) | What |
|---|---|
| `ai_provider_cost_daily` | OpenAI Costs API per UTC day + line item + project, `_id` = `date\|lineItem\|projectId` |
| `ai_provider_topups` | money put into the OpenAI account (never deleted, edits logged) |
| `ai_credits_state` | `pool-settings`, `pool-alerts` (last email per condition), `cost-sync` (last run), `lock:cost-sync` |

## Classes

| Class | Job |
|---|---|
| `WalletLedgerRepository` | wallets, ledger, usage; `adjust` = gian's `adjustCredits` (one transaction: guarded `$inc`, ledger row `adjustment:<key>`, gian audit row) |
| `CreditCatalogueRepository` | prices, packages, settings, with gian's audit action names |
| `ProviderCostRepository`, `TopUpRepository`, `PoolStateRepository` | the OpenAI side |
| `TrackedCostRepository`, `GianAuditRepository` | read-only views of gian's call logs and audit |
| `AiPoolService` | pool, runway, coverage (unused credits ÷ average credits-per-USD), daily reconciliation |
| `CostSyncService` | copies OpenAI costs: lock, 30-day backfill, re-fetch last 3 days, replace whole days |
| `PoolAlertService` | low pool / short runway email to super admins + extra addresses, once per 24 h each |
| `CostSyncScheduler` | runs the sync every 6 h in the API process (off in tests, off without a key) |

## Rules worth knowing

- A deduction only matches when `balance - reservedCredits >= amount`, inside the update itself, so
  concurrent staff and running AI requests can't take a wallet below zero (proven in
  `ai-credits.mongo.test.ts` with 10 parallel deductions).
- The same idempotency key applies once; a key used for another client answers `DUPLICATE_REQUEST`.
- gian caches active prices 30 s per process; nothing here can clear that, so price changes reach AI
  requests within 30 s.
- Days are UTC everywhere (OpenAI's buckets are UTC days).

## Tests

`npm test` runs the fakes-based tests. The repository tests need a local replica set:

```
mongod --replSet rs0 --port 27099 --bind_ip 127.0.0.1 --dbpath <empty folder>
# once, in mongosh: rs.initiate()
AI_CREDITS_TEST_MONGO_URI="mongodb://127.0.0.1:27099/?replicaSet=rs0" npm test
```

They refuse a non-localhost URI and drop their own random database afterwards.
