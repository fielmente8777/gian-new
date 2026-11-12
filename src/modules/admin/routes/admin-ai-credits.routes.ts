import { BaseRoutes } from "../../../shared/http/base-routes.js";
import type { AdminAiCreditsController } from "../controllers/admin-ai-credits.controller.js";
import {
  AdjustCreditsDto,
  adjustmentSchema,
  AiAuditQueryDto,
  aiAuditPageSchema,
  AiClientListQueryDto,
  aiClientPageSchema,
  AiClientParamsDto,
  aiClientSchema,
  aiOverviewSchema,
  AiSettingsDto,
  aiSettingsSchema,
  BulkGrantDto,
  bulkGrantSchema,
  CostsQueryDto,
  CreatePackageDto,
  CreatePricingDto,
  CreateTopUpDto,
  IdParamsDto,
  LedgerQueryDto,
  ledgerPageSchema,
  packageListSchema,
  pricingListSchema,
  pricingRowSchema,
  reconciliationSchema,
  syncStatusSchema,
  topUpListSchema,
  topUpSchema,
  UpdatePackageDto,
  UpdatePricingDto,
  UpdateTopUpDto,
  WalletStatusDto,
} from "../dtos/admin-ai-credits.dto.js";
import type { AdminAuthenticateMiddleware } from "../middlewares/admin-authenticate.middleware.js";

const PACKAGE = { schema: packageListSchema };

/**
 * /api/v1/admin/ai-credits/*.
 *   credits.view (base):        clients, a client's wallet, usage and ledger (assigned clients only)
 *   credits.manage (advanced):  add/remove credits, suspend/resume, bulk grant (assigned clients only)
 *   credits.pricing (advanced): overview, OpenAI top-ups and costs, pricing, packages, settings, audit
 */
export class AdminAiCreditsRoutes extends BaseRoutes {
  constructor(c: AdminAiCreditsController, auth: AdminAuthenticateMiddleware) {
    super("/admin/ai-credits", { tag: "Admin AI credits" });
    const view = auth.require("credits.view");
    const manage = auth.require("credits.manage");
    const pricing = auth.require("credits.pricing");
    const notFound = { 404: "CLIENT_NOT_FOUND (also for a client outside your properties)" };

    // ── company-wide ──────────────────────────────────────────────────────────────────────
    this.get(
      "/overview",
      {
        summary: "The OpenAI pool, spend, runway, credits sold and unused, and the lowest wallets",
        description:
          "remaining = top-ups recorded by staff - OpenAI's reported cost since the first top-up (OpenAI has no " +
          "balance API). Days are UTC. coverage.ratio below 1 means the pool can't cover every unused credit.",
        response: { schema: aiOverviewSchema },
      },
      pricing,
      c.overview,
    );
    this.get(
      "/openai/costs",
      {
        summary: "OpenAI's daily bill next to what gian recorded, per UTC day",
        description:
          "gapUsd = OpenAI's cost - gian's tracked cost: calls gian didn't record, or models without a price.",
        query: CostsQueryDto,
        response: { schema: reconciliationSchema },
      },
      pricing,
      c.costs,
    );
    this.post(
      "/openai/sync",
      {
        summary: "Fetch OpenAI's costs now (it also runs every 6 hours)",
        response: { schema: syncStatusSchema },
        errors: {
          409: "OPENAI_NOT_CONFIGURED, OPENAI_SYNC_BUSY",
          503: "OPENAI_ADMIN_KEY_REJECTED, OPENAI_ADMIN_API_FAILED",
        },
      },
      pricing,
      c.sync,
    );
    this.get(
      "/openai/topups",
      { summary: "Money put into the OpenAI account", response: { schema: topUpListSchema } },
      pricing,
      c.topUps,
    );
    this.post(
      "/openai/topups",
      {
        summary: "Record a top-up of the OpenAI account",
        description: "Record the balance OpenAI shows on the first day as the first top-up. Logged.",
        body: CreateTopUpDto,
        response: { status: 201, schema: topUpSchema },
      },
      pricing,
      c.addTopUp,
    );
    this.patch(
      "/openai/topups/:id",
      {
        summary: "Correct a top-up (top-ups are never deleted)",
        params: IdParamsDto,
        body: UpdateTopUpDto,
        response: { schema: topUpSchema },
        errors: { 404: "OPENAI_TOPUP_NOT_FOUND" },
      },
      pricing,
      c.editTopUp,
    );

    this.get(
      "/pricing",
      {
        summary: "Model prices, with what one credit costs us and the margin at package prices",
        description: "gian caches prices: a change reaches AI requests within `appliesWithinSeconds`.",
        response: { schema: pricingListSchema },
      },
      pricing,
      c.pricing,
    );
    this.post(
      "/pricing",
      {
        summary: "Price a provider model",
        body: CreatePricingDto,
        response: { status: 201, schema: pricingRowSchema },
        errors: { 409: "AI_PRICING_EXISTS" },
      },
      pricing,
      c.createPricing,
    );
    this.patch(
      "/pricing/:id",
      {
        summary: "Change a model's price",
        params: IdParamsDto,
        body: UpdatePricingDto,
        response: { schema: pricingRowSchema },
        errors: { 404: "AI_PRICING_NOT_FOUND", 409: "AI_PRICING_EXISTS" },
      },
      pricing,
      c.updatePricing,
    );
    this.get(
      "/packages",
      { summary: "Recharge packages the hotel dashboard sells", response: PACKAGE },
      pricing,
      c.packages,
    );
    this.post(
      "/packages",
      {
        summary: "Add a recharge package",
        body: CreatePackageDto,
        response: { status: 201, schema: packageListSchema },
      },
      pricing,
      c.createPackage,
    );
    this.patch(
      "/packages/:id",
      {
        summary: "Change a recharge package (marking one popular unmarks the others)",
        params: IdParamsDto,
        body: UpdatePackageDto,
        response: PACKAGE,
        errors: { 404: "AI_PACKAGE_NOT_FOUND" },
      },
      pricing,
      c.updatePackage,
    );
    this.get(
      "/settings",
      { summary: "Credit settings and OpenAI pool alerts", response: { schema: aiSettingsSchema } },
      pricing,
      c.settings,
    );
    this.put(
      "/settings",
      {
        summary: "Change credit settings and pool alerts",
        body: AiSettingsDto,
        response: { schema: aiSettingsSchema },
        errors: { 400: "AI_THRESHOLDS_INVALID" },
      },
      pricing,
      c.updateSettings,
    );
    this.get(
      "/audit",
      {
        summary: "gian's AI credits audit log (the dashboard owner page's changes and the console's)",
        query: AiAuditQueryDto,
        response: { schema: aiAuditPageSchema },
      },
      pricing,
      c.audit,
    );

    // ── per client ────────────────────────────────────────────────────────────────────────
    this.get(
      "/clients",
      {
        summary: "Clients with their AI wallet",
        description: "Admins see only their assigned clients. Clients in the trash are left out.",
        query: AiClientListQueryDto,
        response: { schema: aiClientPageSchema },
      },
      view,
      c.clients,
    );
    this.post(
      "/clients/bulk-grant",
      {
        summary: "Give the same credits to several clients",
        description:
          "Each client is its own ledger change with key `<batchId>:<ndid>`, so sending the same batch again gives " +
          "nothing twice. A client outside your properties fails alone with CLIENT_NOT_FOUND.",
        body: BulkGrantDto,
        response: { schema: bulkGrantSchema },
      },
      manage,
      c.bulkGrant,
    );
    this.get(
      "/clients/:ndid",
      {
        summary: "A client's wallet and the last 30 days of AI usage",
        params: AiClientParamsDto,
        response: { schema: aiClientSchema },
        errors: notFound,
      },
      view,
      c.client,
    );
    this.get(
      "/clients/:ndid/transactions",
      {
        summary: "A client's credit ledger, newest first",
        params: AiClientParamsDto,
        query: LedgerQueryDto,
        response: { schema: ledgerPageSchema },
        errors: notFound,
      },
      view,
      c.ledger,
    );
    this.post(
      "/clients/:ndid/adjust",
      {
        summary: "Add or remove credits",
        description:
          "One transaction: the wallet, a ledger row and gian's audit row. A deduction can't take more than the " +
          "available credits (balance minus running AI requests). The same idempotencyKey applies once.",
        params: AiClientParamsDto,
        body: AdjustCreditsDto,
        response: { schema: adjustmentSchema },
        errors: { ...notFound, 409: "DUPLICATE_REQUEST", 422: "AI_CREDITS_INSUFFICIENT" },
      },
      manage,
      c.adjust,
    );
    this.put(
      "/clients/:ndid/status",
      {
        summary: "Suspend or resume a client's AI",
        description: "Suspended: gian refuses the client's AI requests whatever the balance.",
        params: AiClientParamsDto,
        body: WalletStatusDto,
        response: { schema: aiClientSchema },
        errors: notFound,
      },
      manage,
      c.setStatus,
    );
  }
}
