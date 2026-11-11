import { randomBytes } from "node:crypto";

import type { ZohoAccess, ZohoBooksApi } from "../../../integrations/zoho/zoho-books.client.js";
import type { Logger } from "../../../shared/logger/logger.js";
import { ZohoNotConfiguredError, ZohoNotConnectedError } from "../errors/billing.errors.js";
import type { PaymentProvider, PaymentSetup, ZohoConnection, ZohoStore } from "../types/zoho.types.js";
import type { TokenCipher } from "./token-cipher.js";

const STATE_TTL_MS = 10 * 60_000;

export interface ZohoStatus {
  /** the server has Zoho's client id, secret and token key */
  configured: boolean;
  connected: boolean;
  orgId: string | null;
  orgName: string | null;
  taxId: string | null;
  taxName: string | null;
  connectedBy: string | null;
  connectedAt: Date | null;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
  /** the redirect URI to register in Zoho's API console */
  redirectUri: string;
  /** whether Zoho's webhook can be accepted (ZOHO_WEBHOOK_TOKEN is set) */
  webhookReady: boolean;
  payment: PaymentSetup;
}

/**
 * The single Zoho Books connection for Eazotel's own organisation, and the switch that says
 * where hotels pay. A super admin connects once (Zoho's sign-in, then back to the console);
 * the refresh token is stored encrypted and swapped for a fresh access token when needed.
 *
 * Switching to Zoho needs a working connection; disconnecting while on Zoho puts payments
 * back on Razorpay, so hotels are never left without a way to pay.
 */
export class ZohoConnectionService {
  constructor(
    private readonly store: ZohoStore,
    private readonly api: ZohoBooksApi | null,
    private readonly cipher: TokenCipher | null,
    private readonly redirectUri: string,
    private readonly consoleUrl: string,
    private readonly webhookReady: boolean,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get configured(): boolean {
    return this.api !== null && this.cipher !== null;
  }

  async status(): Promise<ZohoStatus> {
    const [c, payment] = await Promise.all([this.store.connection(), this.store.paymentSetup()]);
    return {
      configured: this.configured,
      connected: c !== null,
      orgId: c?.orgId ?? null,
      orgName: c?.orgName ?? null,
      taxId: c?.taxId ?? null,
      taxName: c?.taxName ?? null,
      connectedBy: c?.connectedBy ?? null,
      connectedAt: c?.connectedAt ?? null,
      lastSyncAt: c?.lastSyncAt ?? null,
      lastSyncError: c?.lastSyncError ?? null,
      redirectUri: this.redirectUri,
      webhookReady: this.webhookReady,
      payment,
    };
  }

  async provider(): Promise<PaymentProvider> {
    return (await this.store.paymentSetup()).provider;
  }

  /** Zoho's sign-in page; the callback must come back within 10 minutes. */
  async startConnect(by: string): Promise<string> {
    const api = this.mustApi();
    const state = randomBytes(24).toString("base64url");
    await this.store.saveState(state, by, new Date(this.now().getTime() + STATE_TTL_MS));
    return api.authorizeUrl(state, this.redirectUri);
  }

  /**
   * Zoho sends the browser back here. Answers where to send it next: the admin console's Zoho
   * screen, saying whether it worked. Never throws, because a browser is waiting.
   */
  async finishConnect(code: string | undefined, state: string | undefined, error: string | undefined): Promise<string> {
    const back = (result: string) =>
      `${this.consoleUrl.replace(/\/+$/, "")}/billing/zoho?zoho=${encodeURIComponent(result)}`;
    try {
      if (error) return back(`denied`);
      if (!code || !state) return back("invalid");
      const by = await this.store.takeState(state, this.now());
      if (!by) return back("expired");
      const api = this.mustApi();
      const tokens = await api.exchangeCode(code, this.redirectUri);
      if (!tokens.refreshToken) return back("no_refresh_token");
      const access = { accessToken: tokens.accessToken, apiDomain: tokens.apiDomain };
      const [org] = await api.organizations(access);
      if (!org) return back("no_organization");
      const previous = await this.store.connection();
      await this.store.saveConnection({
        orgId: org.id,
        orgName: org.name,
        refreshTokenEnc: this.cipher!.encrypt(tokens.refreshToken),
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.expiresAt,
        apiDomain: tokens.apiDomain,
        // reconnecting the same organisation keeps the chosen tax
        taxId: previous?.orgId === org.id ? previous.taxId : null,
        taxName: previous?.orgId === org.id ? previous.taxName : null,
        connectedBy: by,
        connectedAt: this.now(),
        lastSyncAt: previous?.lastSyncAt ?? null,
        lastSyncError: null,
      });
      this.logger.info({ org: org.name, by }, "Zoho Books connected");
      return back("connected");
    } catch (err) {
      this.logger.warn({ err }, "Zoho Books connection failed");
      return back("failed");
    }
  }

  async disconnect(): Promise<PaymentSetup> {
    const connection = await this.store.connection();
    if (connection && this.api && this.cipher) {
      await this.api.revoke(this.cipher.decrypt(connection.refreshTokenEnc)).catch((err: unknown) => {
        this.logger.warn({ err }, "Zoho refresh token revoke failed; deleting it anyway");
      });
    }
    await this.store.deleteConnection();
    const setup = await this.store.paymentSetup();
    if (setup.provider === "zoho") {
      const back: PaymentSetup = {
        provider: "razorpay",
        changedBy: "system: Zoho disconnected",
        changedAt: this.now(),
      };
      await this.store.savePaymentSetup(back);
      return back;
    }
    return setup;
  }

  async organizations(): Promise<{ id: string; name: string }[]> {
    return this.mustApi().organizations(await this.access());
  }

  async selectOrganization(orgId: string): Promise<void> {
    const org = (await this.organizations()).find((o) => o.id === orgId);
    if (!org) throw new ZohoNotConnectedError("That organisation is not in this Zoho account");
    await this.store.updateConnection({ orgId: org.id, orgName: org.name, taxId: null, taxName: null });
  }

  async taxes(): Promise<{ id: string; name: string; percentage: number }[]> {
    const c = await this.mustConnection();
    return this.mustApi().taxes(await this.access(), c.orgId);
  }

  async setTax(taxId: string | null): Promise<void> {
    if (!taxId) {
      await this.store.updateConnection({ taxId: null, taxName: null });
      return;
    }
    const tax = (await this.taxes()).find((t) => t.id === taxId);
    if (!tax) throw new ZohoNotConnectedError("That tax is not in Zoho Books");
    await this.store.updateConnection({ taxId: tax.id, taxName: `${tax.name} (${tax.percentage}%)` });
  }

  async setProvider(provider: PaymentProvider, by: string): Promise<PaymentSetup> {
    if (provider === "zoho") await this.mustConnection();
    const setup: PaymentSetup = { provider, changedBy: by, changedAt: this.now() };
    await this.store.savePaymentSetup(setup);
    return setup;
  }

  async recordSync(error: string | null): Promise<void> {
    if (await this.store.connection())
      await this.store.updateConnection({ lastSyncAt: this.now(), lastSyncError: error });
  }

  /** The connection and a working access token, refreshed when it is about to expire. */
  async session(): Promise<{ connection: ZohoConnection; access: ZohoAccess }> {
    const connection = await this.mustConnection();
    return { connection, access: await this.access(connection) };
  }

  private async access(known?: ZohoConnection): Promise<ZohoAccess> {
    const c = known ?? (await this.mustConnection());
    if (c.accessToken && c.accessExpiresAt && c.accessExpiresAt > this.now()) {
      return { accessToken: c.accessToken, apiDomain: c.apiDomain };
    }
    const tokens = await this.mustApi().refresh(this.cipher!.decrypt(c.refreshTokenEnc));
    await this.store.updateConnection({
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.expiresAt,
      apiDomain: tokens.apiDomain,
    });
    return { accessToken: tokens.accessToken, apiDomain: tokens.apiDomain };
  }

  private async mustConnection(): Promise<ZohoConnection> {
    this.mustApi();
    const c = await this.store.connection();
    if (!c) throw new ZohoNotConnectedError();
    return c;
  }

  private mustApi(): ZohoBooksApi {
    if (!this.api || !this.cipher) throw new ZohoNotConfiguredError();
    return this.api;
  }
}
