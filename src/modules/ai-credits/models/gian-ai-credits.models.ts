// gian owns these collections and writes them on every AI call. gian-new reads them and, for
// staff actions only, writes them with the same rules gian uses. The schemas below are a copy of
// gian/src/models/aiCredits.model.ts, pinned to the collection names gian's models produce
// (checked against the live database on 2026-11-11). autoIndex is off: gian builds the indexes,
// gian-new never does. ai-credits.schema-drift.test.ts fails when the two copies drift apart.
//
import { model, Schema, Types } from "mongoose";

// AI credit wallet. All credit amounts are whole credits (integers).
// One internal credit is NOT one provider token: credits are derived from the
// provider's cost through AiPricing.creditConversionRate (see
// services/aiCredits/pricing.ts).

const wholeCredits = {
  validator: Number.isInteger,
  message: "{PATH} must be a whole number of credits",
};

/* ------------------------------ AiWallet ------------------------------ */

export interface IAiWallet {
  _id: Types.ObjectId;
  tenantId: string; // ndid
  balance: number; // credits owned by the tenant
  reservedCredits: number; // part of balance held by in-flight AI requests
  totalUsed: number;
  totalPurchased: number;
  totalAdjustedIn: number;
  totalAdjustedOut: number;
  currency: string;
  status: "active" | "suspended";
  lastRechargeAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const aiWalletSchema = new Schema<IAiWallet>(
  {
    tenantId: { type: String, required: true, unique: true, trim: true },
    balance: { type: Number, default: 0, min: 0, validate: wholeCredits },
    reservedCredits: { type: Number, default: 0, min: 0, validate: wholeCredits },
    totalUsed: { type: Number, default: 0, min: 0 },
    totalPurchased: { type: Number, default: 0, min: 0 },
    totalAdjustedIn: { type: Number, default: 0, min: 0 },
    totalAdjustedOut: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "INR", uppercase: true },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    lastRechargeAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

aiWalletSchema.set("autoIndex", false);
export const AiWallet = model<IAiWallet>("AiWallet", aiWalletSchema, "aiwallets");

/* ------------------------- AiCreditTransaction ------------------------- */
// The ledger: one row per real balance change. Holds for in-flight requests
// are not ledger rows (see AiCreditReservation).

export type AiTransactionType = "purchase" | "usage" | "adjustment";

export interface IAiCreditTransaction {
  _id: Types.ObjectId;
  tenantId: string;
  type: AiTransactionType;
  amount: number; // signed: + adds credits, - removes them
  balanceBefore: number;
  balanceAfter: number;
  service?: string | null; // usage: chatbot, knowledge_base, ...
  description: string;
  referenceId: string; // usage: reservation id, purchase: razorpay order id, adjustment: idempotency key
  idempotencyKey: string; // `${type}:${referenceId}`, unique: a reference is applied once
  performedBy?: string | null; // admin email for adjustments
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const aiCreditTransactionSchema = new Schema<IAiCreditTransaction>(
  {
    tenantId: { type: String, required: true },
    type: { type: String, enum: ["purchase", "usage", "adjustment"], required: true },
    amount: { type: Number, required: true, validate: wholeCredits },
    balanceBefore: { type: Number, required: true, min: 0 },
    balanceAfter: { type: Number, required: true, min: 0 },
    service: { type: String, default: null },
    description: { type: String, required: true, maxlength: 500 },
    referenceId: { type: String, required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    performedBy: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

aiCreditTransactionSchema.index({ tenantId: 1, createdAt: -1 });
aiCreditTransactionSchema.index({ tenantId: 1, type: 1, createdAt: -1 });

export const AiCreditTransaction = model<IAiCreditTransaction>(
  "AiCreditTransaction",
  aiCreditTransactionSchema.set("autoIndex", false),
  "aicredittransactions",
);

/* ------------------------------ AiUsageLog ------------------------------ */

// chat: LLM completions, embedding: vector embeddings, stt: speech-to-text
export const AI_CALL_KINDS = ["chat", "embedding", "stt"] as const;
export type AiCallKind = (typeof AI_CALL_KINDS)[number];
// One row per provider + model used by one billed AI operation.

export interface IAiUsageLog {
  _id: Types.ObjectId;
  tenantId: string;
  requestId: string; // the reservation / operation id
  provider: string;
  model: string;
  service: string;
  kind: AiCallKind;
  calls: number; // provider calls in this operation (tool rounds, retries)
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usageSource: "provider" | "estimated"; // estimated when the provider sent no usage
  actualCost: number; // provider cost in `costCurrency`
  costCurrency: string;
  chargedCredits: number;
  uncollectedCredits: number; // owed but not taken: balance ran out mid-request
  priced: boolean; // false when no active AiPricing existed for this model
  status: "completed" | "failed"; // failed: the operation errored after billable usage
  createdAt: Date;
}

const aiUsageLogSchema = new Schema<IAiUsageLog>(
  {
    tenantId: { type: String, required: true },
    requestId: { type: String, required: true },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    service: { type: String, required: true },
    kind: { type: String, enum: AI_CALL_KINDS, required: true },
    calls: { type: Number, default: 1, min: 0 },
    inputTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
    totalTokens: { type: Number, default: 0, min: 0 },
    usageSource: { type: String, enum: ["provider", "estimated"], default: "provider" },
    actualCost: { type: Number, default: 0, min: 0 },
    costCurrency: { type: String, default: "USD" },
    chargedCredits: { type: Number, default: 0, min: 0, validate: wholeCredits },
    uncollectedCredits: { type: Number, default: 0, min: 0 },
    priced: { type: Boolean, default: true },
    status: { type: String, enum: ["completed", "failed"], default: "completed" },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

aiUsageLogSchema.index({ tenantId: 1, createdAt: -1 });
aiUsageLogSchema.index({ tenantId: 1, provider: 1, model: 1, service: 1 });
// a request is logged once per provider/model/kind
aiUsageLogSchema.index({ requestId: 1, provider: 1, model: 1, kind: 1 }, { unique: true });

aiUsageLogSchema.set("autoIndex", false);
export const AiUsageLog = model<IAiUsageLog>("AiUsageLog", aiUsageLogSchema, "aiusagelogs");

/* ------------------------------ AiPricing ------------------------------ */
// Set by Eazotel admins; nothing here is hardcoded. Prices are per 1M tokens
// in `currency`; creditConversionRate is how many credits one unit of that
// currency of provider cost becomes (it carries the margin).

export interface IAiPricing {
  _id: Types.ObjectId;
  provider: string;
  model: string;
  inputPrice: number;
  outputPrice: number;
  embeddingPrice: number;
  requestPrice: number; // per API call, for APIs not billed by tokens (speech-to-text)
  currency: string;
  creditConversionRate: number;
  status: "active" | "inactive";
  updatedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const nonNegative = { type: Number, default: 0, min: 0 };

const aiPricingSchema = new Schema<IAiPricing>(
  {
    provider: { type: String, required: true, trim: true, lowercase: true },
    model: { type: String, required: true, trim: true },
    inputPrice: nonNegative,
    outputPrice: nonNegative,
    embeddingPrice: nonNegative,
    requestPrice: nonNegative,
    currency: { type: String, required: true, uppercase: true, trim: true },
    creditConversionRate: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

aiPricingSchema.index({ provider: 1, model: 1 }, { unique: true });

aiPricingSchema.set("autoIndex", false);
export const AiPricing = model<IAiPricing>("AiPricing", aiPricingSchema, "aipricings");

/* ------------------------- AiCreditReservation ------------------------- */
// Credits held while an AI request runs. Settled with the actual charge, or
// released (fully refunded) when nothing billable happened. Holds that
// outlive expiresAt are released by the sweeper.

export interface IAiCreditReservation {
  _id: Types.ObjectId;
  tenantId: string;
  service: string;
  amount: number;
  idempotencyKey: string;
  status: "held" | "settled" | "released" | "expired";
  chargedCredits?: number;
  expiresAt: Date;
  settledAt?: Date | null;
  createdAt: Date;
}

const aiCreditReservationSchema = new Schema<IAiCreditReservation>(
  {
    tenantId: { type: String, required: true },
    service: { type: String, required: true },
    amount: { type: Number, required: true, min: 0, validate: wholeCredits },
    idempotencyKey: { type: String, required: true },
    status: { type: String, enum: ["held", "settled", "released", "expired"], default: "held" },
    chargedCredits: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    settledAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// the same operation can't run twice at once (a retry after it finished is fine)
aiCreditReservationSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { status: "held" } });
aiCreditReservationSchema.index({ status: 1, expiresAt: 1 });
aiCreditReservationSchema.index({ tenantId: 1, createdAt: -1 });

export const AiCreditReservation = model<IAiCreditReservation>(
  "AiCreditReservation",
  aiCreditReservationSchema.set("autoIndex", false),
  "aicreditreservations",
);

/* --------------------------- AiCreditPackage --------------------------- */

export interface IAiCreditPackage {
  _id: Types.ObjectId;
  name: string;
  credits: number;
  price: number; // in `currency` (major units)
  currency: string;
  status: "active" | "inactive";
  popular: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const aiCreditPackageSchema = new Schema<IAiCreditPackage>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    credits: { type: Number, required: true, min: 1, validate: wholeCredits },
    price: { type: Number, required: true, min: 1 },
    currency: { type: String, default: "INR", uppercase: true },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    popular: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

aiCreditPackageSchema.set("autoIndex", false);
export const AiCreditPackage = model<IAiCreditPackage>("AiCreditPackage", aiCreditPackageSchema, "aicreditpackages");

/* --------------------------- AiRechargeOrder --------------------------- */

export interface IAiRechargeOrder {
  _id: Types.ObjectId;
  tenantId: string;
  packageId: Types.ObjectId;
  packageName: string;
  credits: number;
  amount: number;
  amountPaise: number;
  currency: string;
  razorpayOrderId: string;
  razorpayPaymentId?: string | null;
  status: "created" | "paid" | "failed";
  paidAt?: Date | null;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const aiRechargeOrderSchema = new Schema<IAiRechargeOrder>(
  {
    tenantId: { type: String, required: true },
    packageId: { type: Schema.Types.ObjectId, ref: "AiCreditPackage", required: true },
    packageName: { type: String, required: true },
    credits: { type: Number, required: true, min: 1, validate: wholeCredits },
    amount: { type: Number, required: true, min: 1 },
    amountPaise: { type: Number, required: true, min: 100 },
    currency: { type: String, default: "INR" },
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String, default: null },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
    paidAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

aiRechargeOrderSchema.index({ tenantId: 1, createdAt: -1 });
aiRechargeOrderSchema.index({ status: 1, paidAt: -1 });

aiRechargeOrderSchema.set("autoIndex", false);
export const AiRechargeOrder = model<IAiRechargeOrder>("AiRechargeOrder", aiRechargeOrderSchema, "airechargeorders");

/* --------------------------- AiCreditSettings --------------------------- */
// One document (key "global").

export interface IAiCreditSettings {
  key: string;
  enabled?: boolean; // master switch; missing = off (gian runs AI free and uncharged)
  lowThreshold: number;
  criticalThreshold: number;
  chatReserveCredits: number; // held before each chatbot message
  reserveMultiplier: number; // headroom on estimated holds (knowledge base)
  reservationTtlMinutes: number;
  // Models without an AiPricing row still run (a wallet with credits always
  // gets AI); their usage is charged at these rates until pricing is added.
  fallbackCreditsPer1kTokens: number;
  fallbackCreditsPerRequest: number; // calls that report no tokens (speech-to-text)
  updatedBy?: string | null;
}

const aiCreditSettingsSchema = new Schema<IAiCreditSettings>(
  {
    key: { type: String, default: "global", unique: true },
    enabled: { type: Boolean, default: false },
    lowThreshold: { type: Number, default: 1000, min: 0 },
    criticalThreshold: { type: Number, default: 250, min: 0 },
    chatReserveCredits: { type: Number, default: 25, min: 1, validate: wholeCredits },
    reserveMultiplier: { type: Number, default: 1.25, min: 1, max: 10 },
    reservationTtlMinutes: { type: Number, default: 30, min: 5, max: 24 * 60 },
    fallbackCreditsPer1kTokens: { type: Number, default: 1, min: 0, max: 100_000 },
    fallbackCreditsPerRequest: { type: Number, default: 1, min: 0, max: 100_000 },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

aiCreditSettingsSchema.set("autoIndex", false);
export const AiCreditSettings = model<IAiCreditSettings>(
  "AiCreditSettings",
  aiCreditSettingsSchema,
  "aicreditsettings",
);

/* --------------------------- AiAdminAuditLog --------------------------- */

export interface IAiAdminAuditLog {
  actor: string;
  action: string;
  tenantId?: string | null;
  target?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
  createdAt: Date;
}

const aiAdminAuditLogSchema = new Schema<IAiAdminAuditLog>(
  {
    actor: { type: String, required: true },
    action: { type: String, required: true },
    tenantId: { type: String, default: null },
    target: { type: String, default: null },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    reason: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

aiAdminAuditLogSchema.index({ createdAt: -1 });
aiAdminAuditLogSchema.index({ tenantId: 1, createdAt: -1 });

aiAdminAuditLogSchema.set("autoIndex", false);
export const AiAdminAuditLog = model<IAiAdminAuditLog>("AiAdminAuditLog", aiAdminAuditLogSchema, "aiadminauditlogs");

/* ---------------------------- AiProviderCall ---------------------------- */
// One row per API call made to an AI provider, successful or not: what the
// provider was actually asked to do and what it reported back. Independent of
// wallet credits (those are in AiUsageLog / AiCreditTransaction). Feeds the
// admin API usage analytics.

export interface IAiProviderCall {
  _id: Types.ObjectId;
  tenantId: string | null; // null: the call ran outside any tenant's billed operation
  service: string; // chatbot, whatsapp_ai, ... or 'unattributed'
  requestId: string | null; // the AiCreditReservation id when billed
  provider: string;
  model: string;
  kind: AiCallKind;
  status: "success" | "failed";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  // provider: reported by the provider; estimated: counted from the text
  // because the provider sent no usage; none: not token-based or failed
  usageSource: "provider" | "estimated" | "none";
  metrics: { audioBytes?: number; inputCharacters?: number; embeddingInputs?: number };
  cost: number; // provider cost in costCurrency, from AiPricing at call time
  costCurrency: string;
  priced: boolean;
  latencyMs: number;
  httpStatus: number | null;
  errorType: string | null;
  createdAt: Date;
}

const aiProviderCallSchema = new Schema<IAiProviderCall>(
  {
    tenantId: { type: String, default: null },
    service: { type: String, required: true },
    requestId: { type: String, default: null },
    provider: { type: String, required: true, lowercase: true, trim: true },
    model: { type: String, required: true, trim: true },
    kind: { type: String, enum: AI_CALL_KINDS, required: true },
    status: { type: String, enum: ["success", "failed"], required: true },
    inputTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
    totalTokens: { type: Number, default: 0, min: 0 },
    usageSource: { type: String, enum: ["provider", "estimated", "none"], default: "none" },
    metrics: {
      audioBytes: { type: Number, min: 0 },
      inputCharacters: { type: Number, min: 0 },
      embeddingInputs: { type: Number, min: 0 },
    },
    cost: { type: Number, default: 0, min: 0 },
    costCurrency: { type: String, default: "UNKNOWN" },
    priced: { type: Boolean, default: false },
    latencyMs: { type: Number, default: 0, min: 0 },
    httpStatus: { type: Number, default: null },
    errorType: { type: String, default: null, maxlength: 120 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

aiProviderCallSchema.index({ createdAt: -1 });
aiProviderCallSchema.index({ provider: 1, model: 1, createdAt: -1 });
aiProviderCallSchema.index({ tenantId: 1, createdAt: -1 });
aiProviderCallSchema.index({ requestId: 1 });

aiProviderCallSchema.set("autoIndex", false);
export const AiProviderCall = model<IAiProviderCall>("AiProviderCall", aiProviderCallSchema, "aiprovidercalls");
