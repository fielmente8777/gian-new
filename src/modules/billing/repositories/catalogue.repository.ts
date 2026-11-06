import mongoose, { Types } from "mongoose";

import { ObjectIds } from "../../../shared/database/object-id.js";
import {
  DEFAULT_BILLING_SETTINGS,
  DEFAULT_CUSTOM_PRICING,
  DEFAULT_LIMITS,
  TRIAL_PLAN_CODE,
  UNLIMITED,
} from "../constants/billing.constants.js";
import type {
  AppInput,
  BillingSettings,
  CatalogueApp,
  CataloguePlan,
  CatalogueStore,
  PlanInput,
  PlanLimits,
  SupportLevel,
} from "../types/billing.types.js";

interface PlanDoc {
  _id: Types.ObjectId;
  planName?: string;
  price?: number;
  displayName?: string;
  tagline?: string;
  includedApps?: string[];
  highlights?: string[];
  limits?: Partial<PlanLimits>;
  support?: SupportLevel;
  modules?: Record<string, boolean>;
  isPublic?: boolean;
  isCustom?: boolean;
  customPriceLabel?: string;
  customPriceNote?: string;
  customCtaLabel?: string;
  visibleTo?: string[];
  isActive?: boolean;
  featured?: boolean;
  sortOrder?: number;
  updatedAt?: Date;
  updatedBy?: string;
}

interface AppDoc {
  _id: Types.ObjectId;
  code?: string;
  name?: string;
  description?: string;
  price?: number;
  isActive?: boolean;
  sortOrder?: number;
}

interface SettingsDoc extends Omit<BillingSettings, "updatedAt" | "updatedBy"> {
  _id: string;
  updatedAt?: Date;
  updatedBy?: string;
}

const TAGLINES: Record<string, string> = {
  BASIC: "For small hotels starting with direct bookings and digital growth.",
  PRO: "For growing hotels that want every channel and automation in one place.",
  ENTERPRISE: "For hotel groups that need custom integrations and dedicated support.",
};

const titleCase = (code: string) => code.charAt(0) + code.slice(1).toLowerCase();

/**
 * The catalogue: gian's `plans` and `apps` (gian's checkout and the website still read them,
 * so their old fields stay and are kept in step) plus `billing_settings`. Fields billing added
 * later fall back to sensible values, so plans that were never edited still work.
 */
export class CatalogueRepository implements CatalogueStore {
  private get planCollection() {
    return mongoose.connection.collection<PlanDoc>("plans");
  }

  private get appCollection() {
    return mongoose.connection.collection<AppDoc>("apps");
  }

  private get settingsCollection() {
    return mongoose.connection.collection<SettingsDoc>("billing_settings");
  }

  async plans(): Promise<CataloguePlan[]> {
    const docs = await this.planCollection.find({}).toArray();
    return docs.map((d) => CatalogueRepository.toPlan(d)).sort((a, b) => a.sortOrder - b.sortOrder || a.price - b.price);
  }

  async plan(id: string): Promise<CataloguePlan | null> {
    const _id = ObjectIds.parse(id);
    const doc = _id ? await this.planCollection.findOne({ _id }) : null;
    return doc ? CatalogueRepository.toPlan(doc) : null;
  }

  async createPlan(input: PlanInput, by: string, now: Date): Promise<CataloguePlan> {
    const _id = new Types.ObjectId();
    await this.planCollection.insertOne({ _id, ...CatalogueRepository.toPlanDoc(input), createdAt: now, updatedAt: now, updatedBy: by } as PlanDoc);
    return (await this.plan(String(_id)))!;
  }

  async updatePlan(id: string, changes: Partial<PlanInput>, by: string, now: Date): Promise<CataloguePlan | null> {
    const _id = ObjectIds.parse(id);
    if (!_id) return null;
    const current = await this.plan(id);
    if (!current) return null;
    const merged = { ...current, ...changes };
    await this.planCollection.updateOne(
      { _id },
      { $set: { ...CatalogueRepository.toPlanDoc(merged), updatedAt: now, updatedBy: by } },
    );
    return this.plan(id);
  }

  async apps(): Promise<CatalogueApp[]> {
    const docs = await this.appCollection.find({}).toArray();
    return docs
      .map((d) => ({
        id: String(d._id),
        code: String(d.code ?? ""),
        name: String(d.name ?? ""),
        description: d.description ?? "",
        price: Number(d.price ?? 0),
        isActive: d.isActive !== false,
        sortOrder: d.sortOrder ?? 100,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async createApp(input: AppInput, now: Date): Promise<CatalogueApp> {
    const _id = new Types.ObjectId();
    // gian's App model also wants `type`
    await this.appCollection.insertOne({ _id, ...input, type: "fixed", createdAt: now, updatedAt: now } as AppDoc);
    return (await this.apps()).find((a) => a.id === String(_id))!;
  }

  async updateApp(id: string, changes: Partial<AppInput>, now: Date): Promise<CatalogueApp | null> {
    const _id = ObjectIds.parse(id);
    if (!_id) return null;
    const result = await this.appCollection.updateOne({ _id }, { $set: { ...changes, updatedAt: now } as Partial<AppDoc> });
    if (!result.matchedCount) return null;
    return (await this.apps()).find((a) => a.id === id) ?? null;
  }

  async settings(): Promise<BillingSettings> {
    const doc = await this.settingsCollection.findOne({ _id: "default" });
    if (!doc) return { ...DEFAULT_BILLING_SETTINGS, updatedAt: null, updatedBy: null };
    return {
      currency: doc.currency ?? DEFAULT_BILLING_SETTINGS.currency,
      gstPercent: doc.gstPercent ?? DEFAULT_BILLING_SETTINGS.gstPercent,
      seatPrice: doc.seatPrice ?? DEFAULT_BILLING_SETTINGS.seatPrice,
      cycles: (doc.cycles?.length ? doc.cycles : DEFAULT_BILLING_SETTINGS.cycles).slice().sort((a, b) => a.months - b.months),
      trialDays: doc.trialDays ?? DEFAULT_BILLING_SETTINGS.trialDays,
      invoice: { ...DEFAULT_BILLING_SETTINGS.invoice, ...(doc.invoice ?? {}) },
      updatedAt: doc.updatedAt ?? null,
      updatedBy: doc.updatedBy ?? null,
    };
  }

  async saveSettings(
    settings: Omit<BillingSettings, "updatedAt" | "updatedBy">,
    by: string,
    now: Date,
  ): Promise<BillingSettings> {
    await this.settingsCollection.updateOne(
      { _id: "default" },
      { $set: { ...settings, updatedAt: now, updatedBy: by } },
      { upsert: true },
    );
    return this.settings();
  }

  private static toPlan(d: PlanDoc): CataloguePlan {
    const code = String(d.planName ?? "PLAN");
    const price = Number(d.price ?? 0);
    const limits: PlanLimits = {
      teamMembers: d.limits?.teamMembers ?? DEFAULT_LIMITS.teamMembers,
      properties: d.limits?.properties ?? (d.modules?.unlimitedLocation ? UNLIMITED : DEFAULT_LIMITS.properties),
      aiCreditsMonthly: d.limits?.aiCreditsMonthly ?? DEFAULT_LIMITS.aiCreditsMonthly,
      maxLeadsPerMonth: d.limits?.maxLeadsPerMonth ?? DEFAULT_LIMITS.maxLeadsPerMonth,
    };
    return {
      id: String(d._id),
      code,
      name: d.displayName || titleCase(code),
      tagline: d.tagline ?? TAGLINES[code] ?? "",
      price,
      includedApps: d.includedApps ?? [],
      highlights: d.highlights ?? [],
      limits,
      support: d.support ?? "standard",
      isPublic: d.isPublic ?? code !== TRIAL_PLAN_CODE,
      isCustom: d.isCustom ?? (price === 0 && code !== TRIAL_PLAN_CODE),
      // left empty in the admin console = the default wording
      customPriceLabel: d.customPriceLabel || DEFAULT_CUSTOM_PRICING.customPriceLabel,
      customPriceNote: d.customPriceNote || DEFAULT_CUSTOM_PRICING.customPriceNote,
      customCtaLabel: d.customCtaLabel || DEFAULT_CUSTOM_PRICING.customCtaLabel,
      visibleTo: d.visibleTo ?? [],
      isActive: d.isActive ?? true,
      featured: d.featured ?? code === "PRO",
      sortOrder: d.sortOrder ?? price,
      updatedAt: d.updatedAt ?? null,
    };
  }

  /** New fields plus gian's old ones (`modules`, `limits`), so gian's checkout keeps working. */
  private static toPlanDoc(p: PlanInput): Omit<PlanDoc, "_id"> {
    return {
      planName: p.code,
      displayName: p.name,
      tagline: p.tagline,
      price: p.price,
      includedApps: p.includedApps,
      highlights: p.highlights,
      limits: p.limits,
      support: p.support,
      modules: {
        corePlatform: true,
        aiLayer: p.limits.aiCreditsMonthly !== 0,
        analytics: true,
        automation: p.includedApps.length > 3,
        integrations: true,
        unlimitedLocation: p.limits.properties === UNLIMITED,
      },
      isPublic: p.isPublic,
      isCustom: p.isCustom,
      customPriceLabel: p.customPriceLabel,
      customPriceNote: p.customPriceNote,
      customCtaLabel: p.customCtaLabel,
      visibleTo: p.visibleTo,
      isActive: p.isActive,
      featured: p.featured,
      sortOrder: p.sortOrder,
    };
  }
}
