import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { Model } from "mongoose";

import * as shared from "../models/gian-ai-credits.models.js";

// gian owns these collections. gian-new keeps a copy of gian's schemas so its staff writes pass
// the same validation; this test fails when gian adds, removes or renames a field and the copy
// in models/gian-ai-credits.models.ts was not updated. It reads gian's source next to this repo
// (d:\eazotel-work\gian) and is skipped when that checkout isn't there (e.g. in CI).

const GIAN_MODELS = fileURLToPath(new URL("../../../../../gian/src/models/aiCredits.model.ts", import.meta.url));

/** schema variable in gian's file → the model gian-new built from its copy */
const MODELS: Record<string, Model<never>> = {
  aiWalletSchema: shared.AiWallet as unknown as Model<never>,
  aiCreditTransactionSchema: shared.AiCreditTransaction as unknown as Model<never>,
  aiUsageLogSchema: shared.AiUsageLog as unknown as Model<never>,
  aiPricingSchema: shared.AiPricing as unknown as Model<never>,
  aiCreditReservationSchema: shared.AiCreditReservation as unknown as Model<never>,
  aiCreditPackageSchema: shared.AiCreditPackage as unknown as Model<never>,
  aiRechargeOrderSchema: shared.AiRechargeOrder as unknown as Model<never>,
  aiCreditSettingsSchema: shared.AiCreditSettings as unknown as Model<never>,
  aiAdminAuditLogSchema: shared.AiAdminAuditLog as unknown as Model<never>,
  aiProviderCallSchema: shared.AiProviderCall as unknown as Model<never>,
};

/** collection names verified against the live database on 2026-11-11 */
const COLLECTIONS: Record<string, string> = {
  aiWalletSchema: "aiwallets",
  aiCreditTransactionSchema: "aicredittransactions",
  aiUsageLogSchema: "aiusagelogs",
  aiPricingSchema: "aipricings",
  aiCreditReservationSchema: "aicreditreservations",
  aiCreditPackageSchema: "aicreditpackages",
  aiRechargeOrderSchema: "airechargeorders",
  aiCreditSettingsSchema: "aicreditsettings",
  aiAdminAuditLogSchema: "aiadminauditlogs",
  aiProviderCallSchema: "aiprovidercalls",
};

/**
 * Top-level field names of every `const xSchema = new Schema<…>({ … }, { options })` in gian's
 * file: the lines indented by exactly four spaces inside the first object literal.
 */
const gianFields = (source: string): Map<string, string[]> => {
  const schemas = new Map<string, string[]>();
  const pattern = /const (\w+Schema) = new Schema<\w+>\(\s*\{\n([\s\S]*?)\n {2}\},\n/g;
  for (const match of source.matchAll(pattern)) {
    const fields = [...match[2]!.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]!);
    schemas.set(match[1]!, fields.sort());
  }
  return schemas;
};

describe("gian AI credit schemas", { skip: existsSync(GIAN_MODELS) ? false : "gian checkout not found" }, () => {
  // gian's checkout has Windows line endings
  const gian = gianFields(existsSync(GIAN_MODELS) ? readFileSync(GIAN_MODELS, "utf8").replace(/\r\n/g, "\n") : "");

  it("gian still has exactly the schemas gian-new copies", () => {
    assert.deepEqual([...gian.keys()].sort(), Object.keys(MODELS).sort());
  });

  for (const [name, model] of Object.entries(MODELS)) {
    it(`${name}: same fields as gian, same collection`, () => {
      const ours = Object.keys(model.schema.obj).sort();
      assert.deepEqual(ours, gian.get(name), `${name} drifted from gian/src/models/aiCredits.model.ts`);
      assert.equal(model.collection.collectionName, COLLECTIONS[name]);
    });
  }

  it("never builds indexes on gian's collections", () => {
    for (const model of Object.values(MODELS)) assert.equal(model.schema.get("autoIndex"), false);
  });
});
