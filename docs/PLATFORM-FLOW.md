# Platform flow: onboarding → AI website → CMS → leads

How a hotel goes from the onboarding form to a live website with a working booking engine, and how it changes that site afterwards from the dashboard. Backend: gian-new (Node.js + TypeScript). The booking engine maths is in [BOOKING-ENGINE.md](BOOKING-ENGINE.md).

---

## 1. What happens when a property onboards

```text
Onboarding form (on-boarding app)
   │  POST /api/v1/onboarding          (account, property, rooms, prices, photos, brand, contacts)
   ▼
gian-new  ── creates a ProvisioningJob and returns its id (the form shows live progress)
   │
   ▼  worker runs the steps in order; every step is idempotent and can be retried on its own
 1. tenant          account (ndid) + property (hid), owner user, roles
 2. booking engine  room types, default rate plan, weekday/weekend prices, taxes, policies, 18-month calendar
 3. media           room photos → S3 (+ resized variants) → CloudFront URLs
 4. AI content      site content + SEO generated, validated against the section schemas
 5. GitHub repo     "amaltas" created from the site template, content + images committed
 6. Vercel          project created and linked to the repo, env vars set, first deploy
 7. finish          site record saved (repo, Vercel project, URLs, site key); owner notified
   ▼
Live: https://<slug>.vercel.app  (custom domain added later from the dashboard)
```

### 1.1 The provisioning job

- Module `modules/provisioning`. One `ProvisioningJob` document per onboarding, holding `steps[]: { name, status: pending|running|done|failed, attempts, output, error, startedAt, finishedAt }`.
- Runs in the **worker** container (BullMQ). The API only creates the job. The onboarding page reads progress from `GET /api/v1/provisioning/:id` (polling or SSE).
- **Each step is idempotent.** It first checks whether its work already exists (e.g. the repo is already there and has our marker file) and reuses it, so a retry never creates duplicates.
- A failed step retries with backoff (3 attempts). After that the job is `failed` and appears in the admin panel with a **Retry from step** button. Nothing is deleted automatically: a half-made repo is kept and reused on retry.
- Every step writes what it created (`hid`, repo URL, Vercel project id…) into `output`, so later steps and support staff can see it.

### 1.2 Step details

| Step | Module / integration | What it does | Done when |
|---|---|---|---|
| tenant | `auth`, `users`, `properties` | create or reuse the account (ndid) and property (hid), owner as admin | ids saved |
| booking engine | `booking-engine` | room types from the form (name, units, occupancy, beds, amenities), rate plan "Best Available Rate", weekday + weekend price, extra adult/child price, GST config, check-in/out times, cancellation policy; builds 18 months of calendar rows | calendar rows exist |
| media | `media` + `integrations/aws-s3` | uploads room photos to S3 and creates webp variants; other photos are prepared (optimised) for the repo | every room has ≥1 image URL |
| AI content | `ai` + `website-builder` | generates the site content and SEO from the form data (§3) | content passes the schema |
| GitHub repo | `integrations/github` | creates a repo from the template and commits `content/site.json` + `public/images/*` in **one commit** | marker file `eazotel.json` exists in the repo |
| Vercel | `integrations/vercel` | creates the project, links the repo, sets env vars and the production branch; the push triggers the deploy | deployment `READY` (Vercel webhook) |
| finish | `website-builder`, `notifications` | stores the site record and sends the owner the link (WhatsApp/email) | — |

### 1.3 Repo and project naming

- Slug = property name → lower-case, ASCII, kebab-case, max 60 chars: `Amaltas` → `amaltas`, `The Jamun Tree` → `the-jamun-tree`.
- **Names already exist.** `amaltas`, `midori` and 100+ others are already on GitHub and Vercel, so the script checks both places first. If the name is taken it tries `amaltas-<city>`, then `amaltas-<city>-2`. The final slug is stored on the site record and used for the repo, the Vercel project and `<slug>.vercel.app`.
- The slug is decided **once**, in the GitHub step, and never recomputed.

### 1.4 GitHub

- Use a **GitHub App** ("Eazotel Provisioner"), not a personal token. Install it on the account/organisation that owns client repos with *Contents: write* and *Administration: write* (needed to create repos). Its private key lives in AWS Secrets Manager. Recommended: move client sites into a dedicated organisation (e.g. `eazotel-sites`) so permissions and billing are separate from internal repos.
- Repo creation: GitHub "create repository from template" (`POST /repos/{owner}/eazotel-site-template/generate`, `private: true`).
- Content commit: Git Data API (blobs → tree → commit → update ref), so content + images land as one atomic commit. Images are optimised before committing (webp, ≤ 500 KB each): `midori/public` is already 17 MB and repos must stay small.
- Branches: `main` = production (Vercel production branch), `pre-prod` = drafts / preview. Existing sites (amaltas, midori) use `pre-prod` as production, so the site record stores `productionBranch` per site.

### 1.5 Vercel

- Vercel REST API with a team token (team `eazotel`, Secrets Manager): create the project (framework `nextjs`, git repo linked, production branch), then set env vars:

  | Var | Example |
  |---|---|
  | `NEXT_PUBLIC_EAZOTEL_API` | `https://api.eazotel.com` |
  | `NEXT_PUBLIC_SITE_KEY` | public site key (identifies the site for leads + booking, safe in the browser) |
  | `NEXT_PUBLIC_HID` | property id |
  | `NEXT_PUBLIC_ASSETS_URL` | CloudFront domain |

- The Vercel GitHub integration must have access to the new repo. With "all repositories" on the client-sites organisation this is automatic.
- A Vercel webhook (`deployment.succeeded` / `deployment.error`) calls `POST /api/v1/webhooks/vercel`, so we know when a publish is live.
- Custom domain: added later from the dashboard (Vercel domains API). The dashboard shows the DNS records to set.

---

## 2. The site template (`eazotel-site-template`)

Every new client site is generated from this repo. It is built from the patterns already used in `midori`/`amaltas`, but content is **data**, not code.

```text
eazotel-site-template/
  eazotel.json                 marker: siteId, templateVersion, schemaVersion
  content/site.json            ALL page content + SEO (the only file the CMS writes, besides images)
  public/images/               non-room images (gallery, hero, about…) committed by the CMS
  src/app/layout.tsx           generateMetadata() from site.json SEO
  src/app/page.tsx             renders site.json sections in order through a section registry
  src/app/[page]/page.tsx      extra pages (rooms, gallery, contact…) from site.json pages
  src/app/sitemap.ts  robots.ts  thank-you/
  src/sections/<Type>/         Hero, About, Rooms, Amenities, Experiences, Gallery, Reviews, Offer, Faq, Location, FinalCta…
  src/lib/content.ts           loads site.json and validates it with the site schema (build fails on bad content)
  src/lib/booking.ts           booking engine client: rooms, live prices, availability (runtime, not build time)
  src/hooks/useLeadForm.ts     the one lead hook (§5)
  src/components/booking-widget/
```

- Stack: latest Next.js (App Router, TypeScript), Tailwind CSS 4, React 19. The template is upgraded centrally.
- **Two kinds of data:**
  - *content* (texts, images, SEO, sections) is committed in the repo and built statically: fast, cheap, and the site stays up even if the API is down;
  - *booking data* (rooms, prices, availability) is fetched live from gian-new, so price changes never need a redeploy.
- **Section schemas** (zod) live in a shared package `@eazotel/site-schema` (GitHub Packages). gian-new, the dashboard editor and the template all use the same schema, so the AI, the editor and the renderer agree on what each section contains. `site.json` carries `schemaVersion`; gian-new upgrades old content when the schema changes.
- **Template updates reach existing sites by PR.** Every client has its own repo, so an improvement to the template doesn't flow automatically. A script opens a PR "upgrade template vX → vY" on each site repo and records `templateVersion` on the site.

---

## 3. AI: generating the first site

- Module `modules/ai`. The LLM provider sits behind an `LlmProvider` interface, so the model can change without touching the flow.
- Input: onboarding answers (name, location, type, rooms, amenities, nearby places, tone, contacts) + photo list with captions.
- Output: **structured JSON** matching `SiteContent` (sections + SEO), not code. Steps:
  1. Prompt with the schema and the facts.
  2. zod-validate the result.
  3. If it fails, re-ask once or twice with the validation errors.
  4. If it still fails, fall back to the template defaults filled with the plain facts.
- **No invented facts.** The AI may only use what the owner gave us. No made-up ratings, reviews, awards, distances or prices. Sections without data (e.g. Reviews) are left out. Contacts, address and prices always come from the form/booking engine, never from the AI text.
- Each generation stores prompt version, model, input hash and output (audit + reproducibility).

---

## 4. CMS: changing the site from the dashboard

Module `modules/website-builder`. **gian-new is the source of truth.** The repo receives a commit on every save/publish.

```text
Dashboard → Website
   ├─ Edit with AI:  "make the hero about monsoon stays and add a FAQ on pets"
   │      → AI returns a list of edits (set/insert/remove/move on content paths only)
   │      → applied to a copy, schema-validated, shown as a before/after diff
   ├─ Edit by hand:  forms generated from the section schemas (same result: a new draft)
   ├─ Images:        room photos → S3/CloudFront; other images → repo public/images
   ├─ SEO:           per-page title, description, keywords, OG image, canonical, index/noindex
   ▼
Save draft  → commit content to `pre-prod` → Vercel preview URL shown in the dashboard
Publish     → same content committed to the production branch → live in ~1 min (Vercel webhook → "Live")
Rollback    → pick an older published version → publish it again
```

- **Versions:** `site_versions` holds every saved draft/published snapshot (immutable, with author, prompt, diff and commit SHA). Publishing = choosing a version.
- **What the AI may change:** only content paths in `site.json`. It cannot change code, booking prices, payment settings or anything outside the schema. Changes to **contact phone/email/address** are highlighted and need an extra confirm.
- **Guardrails:** prompt length limit, per-account rate limit / credits, and the result must pass the schema. Only users with the `website:edit` permission can save, and only those with `website:publish` can publish.
- **Images:**
  - *Room images* go to S3 behind CloudFront because the booking engine needs them too (§6).
  - *Other images* (hero, gallery, about) are optimised in the worker and committed to `public/images/` in the repo. Adding gallery images manually in the repo also works: the CMS reads the folder listing from GitHub.
- **SEO handled by the CMS:**
  - *Per page:* meta title (≤ 60 chars), meta description (≤ 160), keywords, canonical, Open Graph title/description/image, index/noindex.
  - *Site level:* JSON-LD `Hotel`/`LodgingBusiness` (name, address, geo, phone, amenities, price range from the booking engine), `sitemap.xml`, `robots.txt`, Google Search Console verification tag.
  - The AI can suggest titles and descriptions; length checks keep them valid.
  - Note: Google ignores the keywords meta tag. We store and output it because other tools use it, but it doesn't affect Google ranking.
- **New dashboard CMS:** the current Website screens in `dashboard-new` are replaced by: Pages & sections editor, AI edit box with diff, Media, SEO, Versions/Publish history, Domain. Old screens stay until the new ones are live for all sites.

---

## 5. Leads: one hook for every site

Today each site posts to `https://nexon.eazotel.com/eazotel/addcontacts` with a `Domain` string (`midori/src/hooks/useBookingForm.ts`, `contact.formDomain`). The tenant is guessed from text, which is how leads end up under the wrong property.

New:

- The template's `useLeadForm` posts to `POST {API}/api/v1/public/leads` with header `X-Site-Key: <NEXT_PUBLIC_SITE_KEY>`.
- gian-new resolves the site key → site → `ndid`/`hid`. The body can never choose the tenant.
- The body carries `name`, `phone` (+ country code), `email`, `message`, form name, dates/guests if any, `sourceUrl`, UTM params and the referrer.
- Protection: CORS limited to the site's domains, rate limit per IP + site, honeypot field, optional Cloudflare Turnstile.
- The lead goes into `crm`, then `notifications` (WhatsApp/email to the property, auto-reply to the guest) and the lead webhooks already offered in the dashboard.
- **Old sites keep working:** `/eazotel/addcontacts` stays (served by nexon, later by a gian-new legacy route that maps `Domain` → site). Old sites can switch to the new hook whenever they are next touched.

---

## 6. Media: S3 + CloudFront

- One private S3 bucket (`ap-south-1`) with Block Public Access on. CloudFront in front with Origin Access Control: the bucket is reachable **only** through CloudFront.
- Upload: the dashboard asks gian-new for a presigned PUT (content type + max 10 MB enforced). The browser uploads straight to S3, then gian-new confirms it. The worker creates webp variants (480 / 960 / 1600 px).
- Keys never change: `properties/{hid}/rooms/{roomTypeId}/{uuid}-{width}.webp`. Files are served with `Cache-Control: public, max-age=31536000, immutable`, so CloudFront and browsers cache them for a year, and a new image gets a new key.
- **Keeping cost low:**
  - CloudFront price class 200 (includes India) instead of "All".
  - Pre-sized variants, so the sites use a custom Next.js image loader that picks a variant instead of paying for Vercel image optimisation on these files.
  - An S3 lifecycle rule deletes unconfirmed uploads after 1 day.
  - A cleanup job removes images no longer referenced.
- Module `modules/media` owns the `media_assets` collection (key, hid, kind, sizes, alt text, usedBy). The booking engine and the CMS reference assets by id.

---

## 7. Old and new clients side by side

| Client | Today | After |
|---|---|---|
| Existing sites (amaltas, midori, …) | content in code, leads → nexon `addcontacts` | unchanged and keep working; can be moved to the template one by one |
| Existing booking engines (`BookingEngineReact`) | nexon `/booking/*` | same URLs, answered by gian-new through the nginx cutover ([README §9](../README.md#9-moving-off-nexon-without-breaking-anyone)) |
| New onboardings | — | fully on gian-new: template site, `/api/v1/public/*`, new dashboard CMS |

---

## 8. New modules and integrations this needs

| Module | Owns |
|---|---|
| `provisioning` | onboarding jobs and their steps |
| `website-builder` | sites, content versions, publishing, SEO, domains |
| `media` | media assets, uploads, variants |
| `ai` | generation + edit prompts, LLM provider, audit log |
| `leads` (inside `crm`) | public lead intake, site keys |
| `booking-engine`, `payments` | see BOOKING-ENGINE.md |

| Integration | Used for | Secret |
|---|---|---|
| `integrations/github` | repo from template, commits, folder listing | GitHub App id + private key |
| `integrations/vercel` | projects, env vars, domains, deploy webhooks | team token + webhook secret |
| `integrations/aws-s3` | presigned uploads, variants | IAM role (no keys on EC2/ECS) |
| `integrations/llm` | content generation and edits | provider API key |
