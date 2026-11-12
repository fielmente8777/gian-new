// Proposes AI model prices (gian's aipricings) and three recharge packages (aicreditpackages).
// Both collections are EMPTY on the live database (checked 2026-11-11), so today every AI call is
// charged at aicreditsettings' fallback rate and the hotel dashboard has nothing to buy.
//
// EVERY NUMBER BELOW IS A PLACEHOLDER. Check the provider prices against each provider's pricing
// page, and decide the credit rate and package prices, before running with --apply. After that,
// staff change everything from the admin console (AI credits → Pricing / Packages).
//
//   npx tsx scripts/seed-ai-credits.ts            # dry run: prints what it would add
//   npx tsx scripts/seed-ai-credits.ts --apply    # writes rows that don't exist yet
//
// Existing rows are never changed. Point MONGO_URI at a copy of the database to try it.
import { parseArgs } from "node:util";

import { EnvValidationError, loadConfig } from "../src/config/index.js";
import { CreditCatalogueRepository } from "../src/modules/ai-credits/repositories/credit-catalogue.repository.js";
import type { PackageInput, PricingInput } from "../src/modules/ai-credits/index.js";
import { Database } from "../src/shared/database/database.js";
import { LoggerFactory } from "../src/shared/logger/logger.js";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });

/**
 * Credits per 1 USD of provider cost. 1000 → one credit = $0.001 of provider cost (≈ ₹0.09 at
 * ₹88/$). The margin comes from the package prices below (₹0.14–0.20 per credit).
 */
const CREDITS_PER_USD = 1000;

/** USD per 1M tokens (requestPrice: per call). The models gian meters today, from its code. */
const PRICING: Omit<PricingInput, "currency" | "creditConversionRate" | "status">[] = [
  // website chatbot (eazbotWeb) and WhatsApp AI replies
  { provider: "openai", model: "gpt-5-mini", inputPrice: 0.25, outputPrice: 2, embeddingPrice: 0, requestPrice: 0 },
  // Google review replies
  { provider: "openai", model: "gpt-4o-mini", inputPrice: 0.15, outputPrice: 0.6, embeddingPrice: 0, requestPrice: 0 },
  // email templates (EMAIL_TEMPLATE_AI_MODEL default)
  { provider: "openai", model: "gpt-4o", inputPrice: 2.5, outputPrice: 10, embeddingPrice: 0, requestPrice: 0 },
  // knowledge base / chatbot embeddings
  {
    provider: "openai",
    model: "text-embedding-3-small",
    inputPrice: 0,
    outputPrice: 0,
    embeddingPrice: 0.02,
    requestPrice: 0,
  },
  // knowledge base answers (ANTHROPIC_MODEL default)
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    inputPrice: 3,
    outputPrice: 15,
    embeddingPrice: 0,
    requestPrice: 0,
  },
  // email templates when the Groq path is used
  {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    inputPrice: 0.15,
    outputPrice: 0.75,
    embeddingPrice: 0,
    requestPrice: 0,
  },
  // Sarvam chat and speech-to-text: fill in from Sarvam's price list (0 = falls back to gian's minimum of 1 credit)
  { provider: "sarvam", model: "sarvam-105b", inputPrice: 0, outputPrice: 0, embeddingPrice: 0, requestPrice: 0 },
  { provider: "sarvam", model: "saaras:v4", inputPrice: 0, outputPrice: 0, embeddingPrice: 0, requestPrice: 0 },
];

/** ₹, GST included. */
const PACKAGES: PackageInput[] = [
  { name: "Starter", credits: 2_500, price: 499, currency: "INR", status: "active", popular: false, sortOrder: 10 },
  { name: "Growth", credits: 12_000, price: 1_999, currency: "INR", status: "active", popular: true, sortOrder: 20 },
  { name: "Scale", credits: 35_000, price: 4_999, currency: "INR", status: "active", popular: false, sortOrder: 30 },
];

try {
  const config = loadConfig();
  const database = new Database(config.database, LoggerFactory.create(config.app));
  await database.connect();
  const catalogue = new CreditCatalogueRepository();
  const actor = { email: "scripts/seed-ai-credits.ts", ip: null };
  console.log(
    `Database "${config.database.MONGO_DB}" · ${values.apply ? "APPLYING" : "dry run (add --apply to write)"}\n`,
  );

  const prices = await catalogue.listPricing();
  const priced = new Set(prices.map((p) => `${p.provider}/${p.model}`));
  for (const row of PRICING) {
    const id = `${row.provider}/${row.model}`;
    if (priced.has(id)) {
      console.log(`price ${id}: already set, left as it is`);
      continue;
    }
    const input: PricingInput = { ...row, currency: "USD", creditConversionRate: CREDITS_PER_USD, status: "active" };
    console.log(
      `price ${id}: in $${row.inputPrice} / out $${row.outputPrice} / emb $${row.embeddingPrice} per 1M, ${CREDITS_PER_USD} credits per $`,
    );
    if (values.apply) await catalogue.createPricing(input, actor);
  }

  console.log("");
  const existing = await catalogue.listPackages();
  if (existing.length) {
    console.log(`packages: ${existing.length} already exist, none added`);
  } else {
    for (const p of PACKAGES) {
      console.log(
        `package ${p.name}: ${p.credits} credits for ₹${p.price} (₹${(p.price / p.credits).toFixed(3)} per credit)${p.popular ? ", popular" : ""}`,
      );
      if (values.apply) await catalogue.createPackage(p, actor);
    }
  }

  console.log(values.apply ? "\nDone." : "\nNothing written. Run again with --apply to save.");
  await database.disconnect();
} catch (error) {
  console.error(error instanceof EnvValidationError ? error.message : error);
  process.exit(1);
}
