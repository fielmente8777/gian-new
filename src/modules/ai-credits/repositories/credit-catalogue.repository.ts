import { Types } from "mongoose";

import { DuplicatePricingError } from "../errors/ai-credits.errors.js";
import {
  AiCreditPackage,
  AiCreditSettings,
  AiPricing,
  type IAiCreditPackage,
  type IAiCreditSettings,
  type IAiPricing,
} from "../models/gian-ai-credits.models.js";
import type {
  Actor,
  Changed,
  CreditCatalogueStore,
  CreditPackage,
  CreditSettings,
  PackageInput,
  PricingInput,
  PricingRow,
} from "../types/ai-credits.types.js";
import { inTransaction, WalletLedgerRepository } from "./wallet-ledger.repository.js";

const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;
const objectId = (id: string) => (/^[a-f\d]{24}$/i.test(id) ? new Types.ObjectId(id) : null);

/**
 * gian's model prices, recharge packages and credit settings. Same writes and the same audit
 * action names as gian's admin.service.ts (pricing.create / pricing.update / package.create /
 * package.update / settings.update), so gian's own audit screen reads our changes too.
 *
 * gian caches active prices for 30 seconds per process (getActivePricesCached), and nothing
 * here can clear another server's cache: a price change reaches AI requests within 30 s.
 */
export class CreditCatalogueRepository implements CreditCatalogueStore {
  async listPricing(): Promise<PricingRow[]> {
    return (await AiPricing.find().sort({ provider: 1, model: 1 }).lean()).map(CreditCatalogueRepository.pricing);
  }

  async createPricing(input: PricingInput, actor: Actor): Promise<PricingRow> {
    try {
      return await inTransaction(async (session) => {
        const [row] = await AiPricing.create([{ ...input, updatedBy: actor.email }], { session });
        await WalletLedgerRepository.gianAudit(
          actor,
          "pricing.create",
          { target: `${input.provider}/${input.model}`, after: input },
          session,
        );
        return CreditCatalogueRepository.pricing(row!.toObject());
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw new DuplicatePricingError();
      throw e;
    }
  }

  async updatePricing(id: string, changes: Partial<PricingInput>, actor: Actor): Promise<Changed<PricingRow> | null> {
    const _id = objectId(id);
    if (!_id) return null;
    try {
      return await inTransaction(async (session) => {
        const before = await AiPricing.findOneAndUpdate(
          { _id },
          { $set: { ...changes, updatedBy: actor.email } },
          { session, runValidators: true },
        ).lean();
        if (!before) return null;
        const after = await AiPricing.findById(_id).session(session).lean();
        await WalletLedgerRepository.gianAudit(
          actor,
          "pricing.update",
          {
            target: `${before.provider}/${before.model}`,
            before: CreditCatalogueRepository.pricing(before),
            after: changes,
          },
          session,
        );
        return { before: CreditCatalogueRepository.pricing(before), after: CreditCatalogueRepository.pricing(after!) };
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw new DuplicatePricingError();
      throw e;
    }
  }

  async listPackages(): Promise<CreditPackage[]> {
    return (await AiCreditPackage.find().sort({ sortOrder: 1, price: 1 }).lean()).map(CreditCatalogueRepository.pack);
  }

  async createPackage(input: PackageInput, actor: Actor): Promise<CreditPackage> {
    return inTransaction(async (session) => {
      // only one package is highlighted
      if (input.popular) await AiCreditPackage.updateMany({}, { $set: { popular: false } }, { session });
      const [row] = await AiCreditPackage.create([input], { session });
      await WalletLedgerRepository.gianAudit(
        actor,
        "package.create",
        { target: String(row?._id), after: input },
        session,
      );
      return CreditCatalogueRepository.pack(row!.toObject());
    });
  }

  async updatePackage(
    id: string,
    changes: Partial<PackageInput>,
    actor: Actor,
  ): Promise<Changed<CreditPackage> | null> {
    const _id = objectId(id);
    if (!_id) return null;
    return inTransaction(async (session) => {
      if (changes.popular)
        await AiCreditPackage.updateMany({ _id: { $ne: _id } }, { $set: { popular: false } }, { session });
      const before = await AiCreditPackage.findOneAndUpdate(
        { _id },
        { $set: changes },
        { session, runValidators: true },
      ).lean();
      if (!before) return null;
      const after = await AiCreditPackage.findById(_id).session(session).lean();
      await WalletLedgerRepository.gianAudit(
        actor,
        "package.update",
        { target: String(_id), before: CreditCatalogueRepository.pack(before), after: changes },
        session,
      );
      return { before: CreditCatalogueRepository.pack(before), after: CreditCatalogueRepository.pack(after!) };
    });
  }

  async getSettings(): Promise<CreditSettings> {
    // gian creates the document on first use; do the same so a fresh database works
    const filter = { key: "global" };
    try {
      const doc = await AiCreditSettings.findOneAndUpdate(
        filter,
        { $setOnInsert: filter },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      return CreditCatalogueRepository.settings(doc!);
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      return CreditCatalogueRepository.settings((await AiCreditSettings.findOne(filter).lean())!);
    }
  }

  async updateSettings(changes: Partial<CreditSettings>, actor: Actor): Promise<Changed<CreditSettings>> {
    const before = await this.getSettings();
    return inTransaction(async (session) => {
      const after = await AiCreditSettings.findOneAndUpdate(
        { key: "global" },
        { $set: { ...changes, updatedBy: actor.email } },
        { new: true, session, runValidators: true },
      ).lean();
      await WalletLedgerRepository.gianAudit(actor, "settings.update", { before, after: changes }, session);
      return { before, after: CreditCatalogueRepository.settings(after!) };
    });
  }

  private static pricing(r: IAiPricing): PricingRow {
    return {
      id: String(r._id),
      provider: r.provider,
      model: r.model,
      inputPrice: r.inputPrice ?? 0,
      outputPrice: r.outputPrice ?? 0,
      embeddingPrice: r.embeddingPrice ?? 0,
      requestPrice: r.requestPrice ?? 0,
      currency: r.currency,
      creditConversionRate: r.creditConversionRate,
      status: r.status,
      updatedAt: r.updatedAt ?? null,
      updatedBy: r.updatedBy ?? null,
    };
  }

  private static pack(p: IAiCreditPackage): CreditPackage {
    return {
      id: String(p._id),
      name: p.name,
      credits: p.credits,
      price: p.price,
      currency: p.currency,
      status: p.status,
      popular: Boolean(p.popular),
      sortOrder: p.sortOrder ?? 0,
      updatedAt: p.updatedAt ?? null,
    };
  }

  /** gian's settingsDTO, including its fallbacks for documents saved before a field existed. */
  private static settings(s: IAiCreditSettings): CreditSettings {
    return {
      enabled: s.enabled === true,
      lowThreshold: s.lowThreshold,
      criticalThreshold: s.criticalThreshold,
      chatReserveCredits: s.chatReserveCredits,
      reserveMultiplier: s.reserveMultiplier,
      reservationTtlMinutes: s.reservationTtlMinutes,
      fallbackCreditsPer1kTokens: s.fallbackCreditsPer1kTokens ?? 1,
      fallbackCreditsPerRequest: s.fallbackCreditsPerRequest ?? 1,
    };
  }
}
