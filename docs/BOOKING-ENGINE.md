# Booking engine: data model, pricing calendar and calculations

Module `modules/booking-engine` (+ `modules/payments`) in gian-new. It works like the extranets of Booking.com / channel managers: **per-day rates, availability and restrictions (ARI)** for every room type and rate plan. Hoteliers manage them from a calendar with single-day edits and bulk edits.

"Zero errors" is reached by design, not by hope:

1. All pricing maths lives in one pure class (`PricingEngine`, no DB, no HTTP) that is unit-tested and property-tested.
2. Money is integer paise only.
3. Inventory is changed atomically, so a room can't be sold twice.
4. The price the guest saw is locked (signed quote) and stored on the booking. It is never recomputed later.

---

## 1. Data model

```text
Property (hid)
  timezone "Asia/Kolkata" · currency "INR" · checkInTime 14:00 · checkOutTime 11:00
  weekendNights [FRI, SAT]            ← which nights count as weekend (editable)
  taxProfile → tax slabs (§5)
  │
  ├─ RoomType           name, units (e.g. 6 rooms), baseOccupancy 2, maxAdults 3, maxChildren 2, maxOccupancy 4,
  │                     extra-bed rules, size, beds, amenities, images[] (media ids)
  │
  ├─ RatePlan           "Best Available Rate" · mealPlan EP|CP|MAP|AP · cancellationPolicyId
  │                     default prices per weekday: { MON..SUN } for base occupancy
  │                     extraAdultPrice, childPrices by age band (0–5 free, 6–12 …)
  │                     derived plans: parentId + adjustment (+/- amount or %) — e.g. "Non-refundable = BAR −10%"
  │
  ├─ InventoryDay       (hid, roomTypeId, date)            total, sold, held, outOfOrder, stopSell
  ├─ RateDay            (hid, roomTypeId, ratePlanId, date) price, extraAdultPrice, childPrices,
  │                     closed, closedToArrival, closedToDeparture, minLos, maxLos, minAdvanceDays,
  │                     source: default | rule | manual, ruleId?, updatedBy, updatedAt
  ├─ RateRule           bulk edit kept as a rule: from, to, weekdays mask, action, value (§3)
  ├─ Promotion          promo code / early-bird / last-minute / long-stay (§4)
  ├─ CancellationPolicy tiers (§7)
  └─ Booking            rooms[], guest, the stored price breakdown, status history, payments
```

- **Dates are property-local calendar dates** stored as `"YYYY-MM-DD"` strings. They are not UTC timestamps, so a night never shifts by a day because of time zones. "Today" is computed in the property's time zone.
- **A night belongs to its start date.** A stay `checkIn 2026-11-05 → checkOut 2026-11-08` is the nights of the 5th, 6th and 7th. The checkout date is not charged.
- `RateDay`/`InventoryDay` rows are **materialised** 18 months ahead (a nightly job extends the window). Reads are one indexed range query. Unique indexes: `(hid, roomTypeId, date)` and `(hid, roomTypeId, ratePlanId, date)`.
- Derived rate plans are **not stored per day**. They are computed from the parent at read time, so they can never drift from it.

---

## 2. Which price applies to a night

For each `(roomType, ratePlan, date)` the price comes from the first layer that has one:

| Priority | Layer | Set by | Example |
|---|---|---|---|
| 1 | **Manual day edit** (`source: manual`) | clicking a single day in the calendar | 7 Nov = ₹8,000 |
| 2 | **Rule** (`source: rule`), newest wins | bulk edit over a date range + weekdays | 20 Dec–5 Jan, all days, +25% |
| 3 | **Default weekday/weekend price** (`source: default`) | the rate plan's `MON..SUN` prices | Sun–Thu ₹5,000 · Fri–Sat ₹6,500 |

This is what makes the hotelier's edits safe:

- **Changing the default weekday price** (₹5,000 → ₹5,500) rewrites only rows with `source: default`. Manual edits and rules are kept.
- **A bulk edit** writes `source: rule` rows. By default it **does not overwrite manual edits**. The dialog has a checkbox "also overwrite days I edited by hand".
- **Removing a rule** recomputes those days from the next layer down.
- Every change is recorded in `ari_change_log` (who, when, old → new, which rows). A future channel manager reads ARI changes from there.

Derived plan price = parent price adjusted, then rounded to whole rupees (configurable). Example: Non-refundable = BAR −10%, BAR ₹6,500 → ₹5,850.

---

## 3. The calendar (dashboard)

- **Month grid per room type.** Each cell shows the price per rate plan, rooms left (`total − sold − held − outOfOrder`) and restriction badges (closed, CTA, CTD, min nights).
- **Single-day edit:** click a cell, change price, rooms or restrictions → `PATCH /api/v1/booking-engine/calendar/day`.
- **Bulk edit** (like Booking.com): choose dates *from–to*, **weekdays** (e.g. only Fri+Sat, or only Mon–Thu), room types, rate plans, then an action:
  - `set price` = ₹X · `increase` / `decrease` by ₹X or by X%
  - `set rooms to sell` = N
  - `open` / `close`, CTA, CTD, `min nights` = N, `max nights` = N
  → `POST /api/v1/booking-engine/calendar/bulk` creates a `RateRule` (for prices) or updates `InventoryDay` rows, in a transaction, and returns how many days changed. A preview of the affected days is shown first.
- **Weekday / weekend defaults** live on the rate plan screen: seven price boxes, or two (weekday/weekend) with an "advanced" switch to price each day separately. `weekendNights` on the property decides which nights count as weekend: Fri+Sat by default, some properties use Sat+Sun.
- Copy one room type's or one season's prices onto another.

### Restriction rules (industry convention)

| Restriction | Checked on |
|---|---|
| `closed` / stop-sell | any night of the stay → that room/plan can't be sold |
| `closedToArrival` (CTA) | the check-in date |
| `closedToDeparture` (CTD) | the check-out date |
| `minLos` / `maxLos` | the value on the **check-in** date applies to the whole stay |
| `minAdvanceDays` / same-day cut-off | days between "today" (property tz) and check-in |
| availability | `min` over all nights of `total − sold − held − outOfOrder` ≥ rooms requested |

---

## 4. Calculating a stay price

`PricingEngine.quote(request, calendarRows, ratePlan, promotions, taxProfile)` is pure and deterministic:

1. **Validate the request:** dates (check-in ≥ today, check-out > check-in, max 30 nights), occupancy within the room type's limits, children with ages.
2. **For each room and each night:**
   - `nightly = RateDay.price` (base occupancy)
   - `+ extraAdults × extraAdultPrice` (adults above `baseOccupancy`)
   - `+ Σ child price by age band` (children above the free age)
   - check restrictions and availability (§3)
3. **Promotions**, applied per night on the room price:
   - promo code / early-bird (booked ≥ N days ahead) / last-minute (≤ N days) / long-stay (≥ N nights) / member rate
   - **no stacking by default:** the single best promotion for the guest applies. Each promotion has a `stackable` flag for exceptions.
   - a promotion never takes a night below the rate plan's `floorPrice`.
4. **Taxes per room per night**, on the **discounted** price (§5).
5. **Totals:** `subtotal = Σ discounted nights`, `tax = Σ night taxes`, `total = subtotal + tax`, plus deposit and pay-at-hotel amounts by the payment policy.
6. **Rounding:** every line is computed in **paise** and rounded once (half-up), and totals are sums of the rounded lines, so the invoice always adds up.

### Worked example

Property weekendNights = Fri+Sat. BAR: Sun–Thu ₹5,000, Fri–Sat ₹6,500. **Manual edit: Sat 7 Nov = ₹8,000.** Extra adult ₹1,000/night. Promo code −10%.
Stay: Thu 5 Nov 2026 → Sun 8 Nov 2026, 1 room, 3 adults (base occupancy 2).

| Night | Layer | Base | + extra adult | −10% | GST slab | Tax | Night total |
|---|---|---|---|---|---|---|---|
| Thu 5 Nov | default (weekday) | 5,000 | 6,000 | 5,400 | 5% (≤ 7,500) | 270.00 | 5,670.00 |
| Fri 6 Nov | default (weekend) | 6,500 | 7,500 | 6,750 | 5% (≤ 7,500) | 337.50 | 7,087.50 |
| Sat 7 Nov | **manual** | 8,000 | 9,000 | 8,100 | 18% (> 7,500) | 1,458.00 | 9,558.00 |
| **Total** | | | 22,500 | **20,250** | | **2,065.50** | **₹22,315.50** |

Stored as paise: subtotal `2025000`, tax `206550`, total `2231550`.

Sat 7 Nov shows why the slab must be checked **per night on the charged price**: the same stay has nights in two GST slabs.

---

## 5. Taxes (India GST)

- Tax slabs are **data**, not code: `tax_profiles` → `[{ upTo: 750000 (paise), rate: 5 }, { upTo: null, rate: 18 }]` with `validFrom`, so a government change is a new row and old bookings keep the tax they were sold with.
- The slab is chosen per room per night on the **actual charged price** (after discounts, including extra-person charges).
- The values above follow the GST rates for hotel rooms in effect since 22 Sep 2025 (up to ₹7,500 per room per night 5%, above 18%). **Have the CA confirm them before go-live**, including whether rooms ≤ ₹1,000 are exempt and how extra-bed charges are treated.
- Prices shown to guests: "₹X + taxes" or tax-inclusive, set per property. The breakdown always lists taxes separately.
- Invoices: the property's GSTIN and HSN/SAC 996311 on the booking confirmation (later: invoice PDF).

---

## 6. Booking lifecycle (no overbooking, no wrong price)

```text
quote ──► hold ──► pay ──► confirmed ──► checked_in ──► checked_out
            │        │           └──► cancelled (policy §7) / no_show
            └─ expires after 15 min ─► released
```

1. **Quote:** `POST /api/v1/public/booking/quote` returns the breakdown + a `quoteToken` (signed, contains a hash of the breakdown, valid 15 min). The site/widget shows exactly this.
2. **Create booking:** `POST /api/v1/public/bookings` with `quoteToken`, guest details and an `Idempotency-Key` header.
   - gian-new recomputes the quote. If anything changed it returns `409 PRICE_CHANGED` with the new quote, and the guest sees the new price before paying.
   - **Atomic hold** in one MongoDB transaction: for every night, increment `held` only where `total − sold − held − outOfOrder ≥ rooms`. If any night fails, the whole transaction aborts → `409 ROOMS_UNAVAILABLE`.
   - The booking is saved as `pending_payment` with the **frozen breakdown**, and a Razorpay order is created.
3. **Payment:** Razorpay webhook `payment.captured` (signature verified, processed once by event id) → move `held → sold`, status `confirmed`, emit `booking.confirmed` → notifications, CRM, GRM guest access.
4. **Expiry:** a delayed job releases the hold after 15 min if it is still unpaid. A payment that arrives after expiry is confirmed if the rooms are still free; otherwise it is refunded automatically and the property is alerted.
5. **Hotel-side changes** (dashboard: modify dates, cancel, mark no-show) use the same inventory functions, so counts stay correct.

- MongoDB transactions need a replica set: Atlas is one. The local Docker Mongo runs as a single-node replica set (`--replSet rs0`).
- Payment gateway: each property has its own Razorpay keys (as nexon's `/razorpay/edit/gateway` does today). Keys are stored encrypted (AES-256-GCM, key from Secrets Manager), never returned to the dashboard after saving. The gateway sits behind the `PaymentGateway` interface, so another gateway can be added later.
- Payment options per property: full prepay, deposit % now + rest at hotel, or pay at hotel (with card guarantee later).

---

## 7. Cancellation and refunds

- Policy = ordered tiers, evaluated in the property's time zone against check-in at `checkInTime`. Example: "free until 7 days before; 50% of the total until 48 h before; then the first night is non-refundable; no-show = 100%."
- The refund is computed from the **stored** breakdown (not today's prices) → Razorpay refund → `cancelled` with history → inventory released (`sold −= rooms`).
- The policy text shown to the guest is generated from the same tiers, so the text and the maths can't disagree.

---

## 8. APIs (first version)

| Who | Endpoint | Purpose |
|---|---|---|
| public (site key) | `GET /api/v1/public/booking/rooms?hid=` | room types, images (CloudFront), amenities, "from" price |
| public | `GET /api/v1/public/booking/availability?hid=&checkIn=&checkOut=&adults=&children=` | sellable rooms + plans with prices |
| public | `POST /api/v1/public/booking/quote` | locked price breakdown |
| public | `POST /api/v1/public/bookings` | hold + payment order |
| public | `GET/POST /api/v1/public/bookings/:id/manage` | guest view / cancel (guest token) |
| dashboard | `/api/v1/booking-engine/room-types`, `/rate-plans`, `/promotions`, `/policies`, `/tax-profile` | CRUD |
| dashboard | `GET /api/v1/booking-engine/calendar?from=&to=&roomTypeId=` | calendar grid |
| dashboard | `PATCH /calendar/day`, `POST /calendar/bulk`, `GET /calendar/history` | edits + audit |
| dashboard | `/api/v1/bookings` (list, filter, detail, modify, cancel, no-show) | operations |
| webhook | `POST /api/v1/webhooks/razorpay/:hid` | payment events |

Public endpoints: site key + CORS for the site's domains, rate limited, cacheable `rooms` response (60 s).

---

## 9. Moving existing data from nexon

nexon's booking engine (`/booking/getenginedetails`, `/booking/availablity`, `/price/getprice/all/nextprev/`, `/inventory/getinventory/all/nextprev/`, `/room/*`) is still used by `BookingEngineReact` and hotel sites. Steps:

1. **Read nexon's code and collections** (needs the nexon repo): how it stores rooms, prices and inventory today (`BookingEngineData` and friends) and how it calculates totals, taxes and discounts. Write those rules down here, and compare them to §4 before changing anything for live properties.
2. **Migration script** `scripts/migrate-booking-engine.ts` (dry run by default): maps each property's rooms, prices and inventory into the new collections and prints a per-property report (rooms, nights, price differences). Re-runnable.
3. **Golden tests:** for sample properties and dates, nexon's availability/price answers are recorded and gian-new must produce the same totals (or a documented, approved difference).
4. **Legacy routes** in `booking-engine/routes/booking-engine.legacy.routes.ts` serve the old paths and shapes from the new model. The nginx cutover is one endpoint at a time (README §9). Reads go first; booking creation and payments go last.
5. While nexon still takes bookings for a property, that property's calendar is **owned by nexon**. Ownership flips per property (`bookingEngineOwner: nexon | gian-new`) in one step, so both systems never sell the same rooms.

---

## 10. Tests that must pass before go-live

- `PricingEngine`: every layer combination, weekend definitions, derived plans, extra adults/children, every promotion type, floor price, slab boundary (₹7,500.00 vs ₹7,500.01), rounding (totals = sum of lines), 1-night and 30-night stays, month/year boundaries.
- Property-based tests (fast-check): random calendars and requests → invariants: total = subtotal + tax; no night below floor; same input → same output.
- Inventory: 50 parallel bookings for the last room → exactly one succeeds; holds expire; late payments handled.
- Restrictions: CTA/CTD/minLos/maxLos/closed/advance, each on the right date.
- Time zones: bookings around midnight IST; "today" correct for same-day cut-off.
- Legacy golden tests against nexon (§9).
