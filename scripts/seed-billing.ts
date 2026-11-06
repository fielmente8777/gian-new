// Writes the proposed plan structure into the catalogue: what each plan includes, its limits and
// bullet points, app descriptions, and the billing cycles. Prices stay as they are (BASIC ₹499,
// PRO ₹999, apps as priced in gian). Shows what would change and writes nothing unless --apply.
// After this, staff change everything from the admin console (Billing → Plans & pricing).
//
//   npx tsx scripts/seed-billing.ts            # dry run: prints the changes
//   npx tsx scripts/seed-billing.ts --apply    # writes them
//
// Point MONGO_URI at a copy of the database first if you only want to try it.
import { parseArgs } from "node:util";

import { EnvValidationError, loadConfig } from "../src/config/index.js";
import { CatalogueRepository } from "../src/modules/billing/repositories/catalogue.repository.js";
import type { BillingSettings, PlanInput } from "../src/modules/billing/index.js";
import { Database } from "../src/shared/database/database.js";
import { LoggerFactory } from "../src/shared/logger/logger.js";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });

const CORE = ["Hotel website with CMS and SEO tools", "Front desk and payment gateway", "Google Analytics reports", "Team accounts"];

/** What each existing plan becomes, by planName. Price is never changed here. */
const PLANS: Record<string, Omit<PlanInput, "code" | "price" | "customPriceLabel" | "customPriceNote" | "customCtaLabel">> = {
  BASIC: {
    name: "Basic",
    tagline: "For small hotels starting with direct bookings and online enquiries.",
    includedApps: ["lead_management", "webhook", "wordpress_webhook"],
    highlights: [...CORE, "Lead management", "Website and WordPress enquiry forms", "Email support"],
    limits: { teamMembers: 3, properties: 1, aiCreditsMonthly: 100, maxLeadsPerMonth: 200 },
    support: "standard",
    isPublic: true,
    isCustom: false,
    visibleTo: [],
    isActive: true,
    featured: false,
    sortOrder: 10,
  },
  PRO: {
    name: "Pro",
    tagline: "For growing hotels that want every guest conversation and lead in one place.",
    includedApps: ["lead_management", "webhook", "wordpress_webhook", "whatsapp", "eazbot", "meta"],
    highlights: ["Everything in Basic", "WhatsApp inbox, templates and campaigns", "Eazbot AI chatbot on your website", "Facebook and Instagram lead ads", "Priority support"],
    limits: { teamMembers: 10, properties: 3, aiCreditsMonthly: 1000, maxLeadsPerMonth: 2000 },
    support: "premium",
    isPublic: true,
    isCustom: false,
    visibleTo: [],
    isActive: true,
    featured: true,
    sortOrder: 20,
  },
  ENTERPRISE: {
    name: "Enterprise",
    tagline: "For hotel groups that need every app, more properties and a dedicated manager.",
    includedApps: [
      "lead_management",
      "webhook",
      "wordpress_webhook",
      "whatsapp",
      "eazbot",
      "meta",
      "googleadsinsights",
      "social_media",
      "exotel",
      "grm",
      "booking_engine",
    ],
    highlights: ["Everything in Pro", "Every add-on app included", "Unlimited properties", "Custom integrations", "Dedicated account manager"],
    limits: { teamMembers: 50, properties: -1, aiCreditsMonthly: 10000, maxLeadsPerMonth: -1 },
    support: "enterprise",
    isPublic: true,
    isCustom: true,
    visibleTo: [],
    isActive: true,
    featured: false,
    sortOrder: 30,
  },
};

const APP_TEXT: Record<string, { description: string; sortOrder: number }> = {
  lead_management: { description: "Every enquiry in one list, with stages, follow-ups and notes.", sortOrder: 1 },
  whatsapp: { description: "Shared WhatsApp inbox, approved templates and broadcast campaigns.", sortOrder: 2 },
  eazbot: { description: "AI chatbot on your website that answers guests and captures leads.", sortOrder: 3 },
  meta: { description: "Facebook and Instagram lead ads delivered straight to your leads.", sortOrder: 4 },
  googleadsinsights: { description: "Google Ads spend, clicks and leads in your dashboard.", sortOrder: 5 },
  social_media: { description: "Plan and publish posts to your social channels.", sortOrder: 6 },
  exotel: { description: "Call tracking and recordings with your Exotel number.", sortOrder: 7 },
  booking_engine: { description: "Commission-free booking engine and reservation desk.", sortOrder: 8 },
  grm: { description: "Guests raise requests by QR code; your team tracks them.", sortOrder: 9 },
  webhook: { description: "Receive enquiries from any website form.", sortOrder: 10 },
  wordpress_webhook: { description: "Receive enquiries from WordPress forms.", sortOrder: 11 },
};

const SETTINGS: Omit<BillingSettings, "updatedAt" | "updatedBy" | "invoice"> = {
  currency: "INR",
  gstPercent: 18,
  seatPrice: 500,
  trialDays: 14,
  cycles: [
    { months: 1, label: "Monthly", discountPercent: 0, isActive: true },
    { months: 3, label: "Quarterly", discountPercent: 10, isActive: true },
    { months: 6, label: "Half-yearly", discountPercent: 15, isActive: true },
    { months: 12, label: "Yearly", discountPercent: 30, isActive: true },
  ],
};

const show = (value: unknown) => JSON.stringify(value);

try {
  const config = loadConfig();
  const database = new Database(config.database, LoggerFactory.create(config.app));
  await database.connect();
  const catalogue = new CatalogueRepository();
  const by = "scripts/seed-billing.ts";
  const now = new Date();
  console.log(`Database "${config.database.MONGO_DB}" · ${values.apply ? "APPLYING" : "dry run (add --apply to write)"}\n`);

  const apps = await catalogue.apps();
  const known = new Set(apps.map((a) => a.code));
  for (const plan of await catalogue.plans()) {
    const target = PLANS[plan.code];
    if (!target) {
      console.log(`plan ${plan.code}: left as it is`);
      continue;
    }
    const included = target.includedApps.filter((c) => known.has(c));
    const missing = target.includedApps.filter((c) => !known.has(c));
    const changes = { ...target, includedApps: included };
    const diff = Object.entries(changes).filter(([k, v]) => show(v) !== show(plan[k as keyof typeof plan]));
    console.log(`plan ${plan.code} (₹${plan.price}/month, price unchanged): ${diff.length ? "" : "no changes"}`);
    for (const [k, v] of diff) console.log(`  ${k}: ${show(plan[k as keyof typeof plan])}  →  ${show(v)}`);
    if (missing.length) console.log(`  (skipped unknown app codes: ${missing.join(", ")})`);
    if (values.apply && diff.length) await catalogue.updatePlan(plan.id, changes, by, now);
  }

  console.log("");
  for (const app of apps) {
    const text = APP_TEXT[app.code];
    if (!text || (app.description === text.description && app.sortOrder === text.sortOrder)) continue;
    console.log(`app ${app.code} (₹${app.price}/month, price unchanged): description + order`);
    if (values.apply) await catalogue.updateApp(app.id, text, now);
  }

  const current = await catalogue.settings();
  console.log(`\nsettings: ${show({ gst: current.gstPercent, seat: current.seatPrice, cycles: current.cycles })}`);
  console.log(`      →   ${show({ gst: SETTINGS.gstPercent, seat: SETTINGS.seatPrice, cycles: SETTINGS.cycles })}`);
  // invoice details are entered by staff in the admin console and kept as they are
  if (values.apply) await catalogue.saveSettings({ ...SETTINGS, invoice: current.invoice }, by, now);

  console.log(values.apply ? "\nDone." : "\nNothing written. Run again with --apply to save.");
  await database.disconnect();
} catch (error) {
  console.error(error instanceof EnvValidationError ? error.message : error);
  process.exit(1);
}
