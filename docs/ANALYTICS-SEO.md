# Analytics, Google products, website SEO and local SEO

What the dashboard can show from Google (Analytics 4, Search Console, Tag Manager, Business Profile, Ads, PageSpeed) and from our own data, and how the backend for it is structured in gian-new so a bug can be traced to one small folder.

---

## 1. What exists today (2026-10-31)

| Area | Where | Endpoints | Notes |
|---|---|---|---|
| GA4 reports | **nexon** | `/google/analytics-data`, `-traffic-sources`, `-pages`, `-conversions`, `-devices`, `-geo` `/:hid`, `/google/properties`, `/google/save-property`, `/google/status/:hid`, `/google/disconnect`, `/google/auth` | dashboard `redux/api/analyticsApi.js` |
| Search Console | **nexon** | `/google/gsc-settings`, `/google/save-gsc-settings`, `/google/analytics-search-queries` | dashboard `SearchConsoleQueries.jsx` (clicks, impressions, CTR) |
| GA4 connect (second copy) | **gian** | `/auth/google-analytics/start`, `/callback`, `/google-analytics/sync` | duplicates nexon's connection |
| Business Profile (local) | **gian** | `/seo/oauth/*`, `/seo/locations`, `/seo/locations/:id/reviews` (+ AI reply, approve), `/posts`, `/media`, `/autopilot`, `/seo/disconnect/:id` | `seoController.ts` (716 lines) |
| Rank tracking (website + local geo-grid) | **gian** | `/seo/seo-intelligence/*` (onboarding, keywords, grid scan, radius, tokens, SSE progress) | `serpIntelligence.service.ts` (1,018 lines), DataForSEO + SerpAPI providers, token wallet |
| Google Ads | **gian** | `/api/v1/google-ads/*` | spend, clicks, conversions |
| Own visitor tracker | **gian** | `/api/v1/webtrack/visitors`, `/sessions` | |

### Problems to fix

1. **Shared OAuth client:** `config/google.ts` exports one `oauth2Client` for the whole server, and the callbacks call `oauth2Client.setCredentials(tokens)` (`googleAnalytics.controller.ts`, `gmailOAuth.service.ts`). Under parallel requests one property's tokens can be used for another property's call. gian-new creates **a new OAuth client per request/connection**.
2. **Three separate Google connections** (nexon GA/GSC, gian GA, gian Business Profile). Owners connect Google several times, and the connections go stale independently. gian-new has **one Google connection per property**, with scopes added as products are enabled.
3. **OAuth `state` must be signed and checked** (tenant + nonce + expiry) on every callback, so a callback can't attach tokens to the wrong property.
4. **SSE token in the URL** (`/seo/seo-intelligence/progress?token=`). URLs end up in logs. Use a short-lived, single-use stream ticket instead.
5. Duplicate / dead code: `seo.route.ts` *and* `seoRoutes.ts`, `seo.controller.ts` *and* `seoController.ts`, a commented-out `gmb.route.ts`. Controllers of 700–850 lines mix HTTP, business rules and Google calls.
6. Date ranges use server time (`setHours(0,0,0,0)`), not the property's time zone, so "today" is wrong for part of the day.
7. Every dashboard view calls Google live: slow, quota-hungry, and history is lost (Search Console keeps only 16 months).

---

## 2. What we can get and show

### 2.1 Google Analytics 4 (Data API: `runReport`, `runRealtimeReport`)

| Dashboard block | Metrics | Dimensions |
|---|---|---|
| Overview KPIs | `activeUsers`, `newUsers`, `sessions`, `engagedSessions`, `engagementRate`, `bounceRate`, `averageSessionDuration`, **`screenPageViews` (page views)**, `screenPageViewsPerSession`, `eventCount`, `keyEvents` (GA4's new name for conversions) | `date` (trend), compared with the previous period |
| Realtime | `activeUsers` (last 30 min) | `unifiedScreenName`, `country`, `deviceCategory` |
| Acquisition | sessions, users, engagement, key events | `sessionDefaultChannelGroup`, `sessionSource`, `sessionMedium`, `sessionCampaignName`, `firstUserSource` |
| Pages | `screenPageViews`, `activeUsers`, `userEngagementDuration` (→ avg time), `keyEvents` | `pagePath`, `pageTitle`, `landingPage` |
| Events | `eventCount` | `eventName` (`form_submit`, `click_whatsapp`, `click_call`, `view_rooms`, `begin_checkout`, `purchase`…) |
| Booking funnel | event counts per step | `view_item` → `begin_checkout` → `add_payment_info` → `purchase` (sent by our booking widget) |
| Revenue | `purchaseRevenue`, `transactions` | channel, campaign |
| Devices / tech | users, sessions | `deviceCategory`, `browser`, `operatingSystem` |
| Geography | users, sessions | `country`, `region`, `city` |
| Audience | users | `userAgeBracket`, `userGender`, `language` (only shown when Google provides them; small numbers are withheld by Google) |

### 2.2 Google Search Console (Search Analytics, Sitemaps, URL Inspection APIs)

- **Performance:** `clicks`, `impressions`, `ctr`, `position` by `query`, `page`, `country`, `device`, `date`, `searchAppearance`, per search type (web, image, video, news, Discover).
- **Opportunities:**
  - queries with high impressions and low CTR → rewrite the meta title/description in the CMS;
  - queries at position 8–20 → content to improve.
- **Sitemaps:** list, submit, last read, errors. gian-new **submits the sitemap automatically after every CMS publish**.
- **URL Inspection:** index status, last crawl, canonical chosen by Google, rich-result status per URL. The API allows about 2,000 calls per day per property, so we inspect key pages only.
- Limits to show in the UI: data arrives 2–3 days late, and history goes back 16 months (we keep our own copy, §3.3). The Page Indexing and Core Web Vitals reports are **not** in the API; Core Web Vitals come from PageSpeed/CrUX (§2.6).
- The Google Indexing API is only for job postings and livestream pages, so we don't use it for hotel sites.

### 2.3 Google Tag Manager (Tag Manager API)

GTM holds **configuration, not traffic numbers**. What we show and do:

- **Tag health:**
  - Is the container installed on the site?
  - Last published version and date.
  - Are our standard tags present: GA4 config, booking-funnel events, lead events (form, WhatsApp, call), Meta pixel, Google Ads conversion?
  - Is anything missing or paused?
- **Provisioning:** for new sites, create a container from our standard template (tags, triggers, variables) through the API and put its id into the site template env (`NEXT_PUBLIC_GTM_ID`). Every site then sends the same events and the reports line up.
- Change history: versions with author and date.

### 2.4 Google Business Profile (local SEO)

| Block | Source | Data |
|---|---|---|
| Visibility | Business Profile Performance API (daily) | impressions on Search vs Maps, desktop vs mobile |
| Actions | same | `CALL_CLICKS`, `WEBSITE_CLICKS`, `BUSINESS_DIRECTION_REQUESTS`, `BUSINESS_CONVERSATIONS`, `BUSINESS_BOOKINGS` |
| Search keywords | Performance API (monthly) | the words people searched to find the property, with impressions |
| Reviews | reviews API | rating average and trend, count, **response rate and time**, AI reply drafts (exists) |
| Posts & photos | local posts / media APIs | publish, schedule (autopilot exists) |
| Profile completeness | Business Information API | categories, description, hours, attributes, phone, website: a score with a to-do list |

### 2.5 Google Ads (exists in gian, moves as is)

Cost, impressions, clicks, CTR, CPC, conversions, conversion value, ROAS per campaign. Ads also feed the combined funnel (§2.7).

### 2.6 Website performance (PageSpeed Insights API + CrUX)

Lighthouse scores (Performance, SEO, Accessibility, Best Practices) for mobile and desktop, plus real-user Core Web Vitals: **LCP, INP, CLS**. Runs weekly and after each publish, and keeps a trend.

### 2.7 Our own data (what Google can't show)

- Leads by source/campaign (UTM saved on every lead, PLATFORM-FLOW §5), bookings and revenue by source (UTM saved on every booking).
- **Combined funnel:** Search impressions → site visits → booking-widget opens → quotes → bookings → revenue, and leads beside it. This is the main "is my marketing working" view for an owner.
- The own web tracker (visitors, sessions) remains as a fallback when GA4 isn't connected.

---

## 3. Backend structure in gian-new

### 3.1 Modules

```text
src/integrations/google/                  one class per Google API, zod schemas for its responses
  GoogleOAuth.ts                          builds a NEW OAuth2 client per connection, refreshes tokens
  Ga4DataClient.ts  Ga4AdminClient.ts     reports / list properties
  SearchConsoleClient.ts                  searchanalytics, sitemaps, urlInspection
  TagManagerClient.ts                     containers, versions, tags
  BusinessProfileClient.ts                accounts, locations, performance, reviews, posts, media
  GoogleAdsClient.ts  PageSpeedClient.ts
  google.errors.ts                        maps Google errors → our codes (§3.4)
  __fixtures__/                           recorded responses for tests

src/modules/google-connect/               ONE Google connection per property
  controllers/ services/ repositories/ models/ dtos/ routes/ config/ __tests__/
  models/google-connection.model.ts       hid, googleAccountEmail, scopes[], encrypted refresh token, status, lastError
  services/google-connect.service.ts      start (signed state) → callback → store → pick GA4 property / GSC site / GBP location / Ads customer

src/modules/analytics/
  overview/                               combined KPIs + funnel (reads snapshots only)
  ga4/                                    reports + realtime
  search-console/                         performance, opportunities, sitemaps, url inspection
  tag-manager/                            tag health, container provisioning
  business-profile-insights/              visibility, actions, search keywords
  ads/                                    campaigns
  web-tracker/                            own tracker (moved from gian)
  sync/                                   jobs that pull each source daily into snapshots (§3.3)
  each sub-folder: controllers/ services/ repositories/ models/ dtos/ mappers/ jobs/ __tests__/

src/modules/seo/
  website-seo/                            rank tracking for site keywords, on-page audit, PageSpeed/CWV, sitemap status
  local-seo/                              GBP profile, reviews (+ AI replies), posts autopilot, geo-grid scans, NAP consistency
  keywords/                               suggestions, tracked keywords, competitors
  providers/                              SerpProvider interface → DataForSeoProvider, SerpApiProvider (already exist in gian)
  credits/                                token wallet for paid scans (moved from gian)
```

### 3.2 Website SEO (improvements)

- **On-page audit for every site.**
  - For our template sites it runs straight from `site.json`: title and description length, one H1 per page, alt text on every image, canonical, Open Graph image, JSON-LD validity, internal links, sitemap/robots.
  - For other sites a light crawler (worker, polite rate limit) does the same.
  - Each issue has a severity and a "Fix in CMS" link.
- **Rank tracking:** tracked keywords (desktop/mobile, country/city) checked on a schedule, with position history, best/worst, and the URL that ranks.
- **Publish hook:** after a CMS publish, submit the sitemap to Search Console, re-run PageSpeed on changed pages, and record a marker on charts ("published v12"), so owners see the effect of changes.

### 3.3 Local SEO (improvements)

- **NAP consistency check:** the name, address and phone in Business Profile, in the website (`site.json`) and in the booking-engine property must match. Differences are flagged, because they hurt local ranking.
- Profile completeness score and to-do list (§2.4).
- Geo-grid scans (exists): scheduled per keyword, competitors shown on the same grid, trend per grid point. Paid scans cost credits.
- Reviews: alerts for new low ratings, AI reply drafts the owner approves (exists), response-rate KPI.

### 3.4 Built to make bugs easy to find

- **Snapshots, not live calls.** Sync jobs pull each source daily (and on demand, with a lock so it never runs twice at once) into `analytics_daily { hid, source, date, dimensions, metrics, syncedAt }`. Dashboard pages read only snapshots, so they are fast, quota-safe, and keep history beyond Google's limits. Realtime is the only live call (cached 60 s).
- **One sub-folder per Google product**, with its own client, zod response schema, mapper, job and tests. A wrong Search Console number is in `search-console/` and nowhere else.
- **Every Google response is zod-validated.** When Google changes a field, it fails in one place with a clear error.
- **Stable error codes** shown in the dashboard, each with a fix action: `GOOGLE_TOKEN_REVOKED` (→ Reconnect), `GOOGLE_SCOPE_MISSING`, `GA4_PROPERTY_NOT_FOUND`, `GSC_SITE_NOT_VERIFIED`, `GBP_LOCATION_NOT_VERIFIED`, `GOOGLE_QUOTA_EXCEEDED` (→ retried automatically with backoff).
- **Connection health page:** every product's status (connected, last sync, last error) per property.
- **Structured logs** with `hid`, `product`, `operation`, `requestId` and the Google request id.
- **Time zones:** every range is computed in the property's time zone. GA4 reports use the GA property's own time zone, and both are shown when they differ.
- **Tests:** recorded Google fixtures for every client; mapper unit tests; one contract test per dashboard endpoint.

---

## 4. Dashboard pages (new)

| Page | Contents |
|---|---|
| **Overview** | KPI cards (users, sessions, page views, leads, bookings, revenue, search clicks, GBP calls + directions) with change vs previous period, the combined funnel, channel mix |
| **Website traffic** (GA4) | acquisition, pages, events, booking funnel, devices, geography, realtime |
| **Search** (Search Console) | queries, pages, countries, devices, position trend, CTR opportunities, sitemaps and index status |
| **Local** (Business Profile) | visibility, actions, search keywords, reviews, posts, completeness, NAP check |
| **SEO health** | on-page audit, PageSpeed/CWV trend, rank tracking, geo-grid |
| **Tags** (GTM) | tag health, missing tags, versions |
| **Ads** | campaigns, cost vs bookings |
| **Connections** | one Google connect button; per-product status and reconnect |

Every page has the same date picker (property time zone, compare with previous period), a "data as of" label, and empty states that say what to connect.

---

## 5. Migration without breaking

1. nexon `/google/*` and gian `/seo/*`, `/auth/google-analytics/*` keep working unchanged while gian-new's modules are built and tested.
2. Existing Google tokens: if they were issued for the same Google OAuth client id, the refresh tokens are copied into `google_connections` (encrypted) and owners don't reconnect. Otherwise each owner reconnects once, from the new Connections page.
3. The dashboard switches page by page to the new `/api/v1/analytics/*` and `/api/v1/seo/*` endpoints. Old endpoints are cut over at nginx (nexon) or retired from gian once nothing calls them (README §9).
