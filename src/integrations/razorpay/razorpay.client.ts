import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { RazorpayConfig } from "./razorpay.config.js";

const API = "https://api.razorpay.com/v1";
const TIMEOUT_MS = 15_000;

/** What billing needs from a payment gateway. Razorpay today; tests use a fake. */
export interface PaymentGateway {
  readonly keyId: string;
  createOrder(input: { amountPaise: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<{
    id: string;
    amount: number;
    currency: string;
  }>;
  /** A recurring plan: `amountPaise` every `intervalMonths` months. */
  createPlan(input: { name: string; amountPaise: number; currency: string; intervalMonths: number }): Promise<{
    id: string;
  }>;
  /** A mandate the customer authorises once; the first charge happens at `startAt`. */
  createSubscription(input: {
    planId: string;
    totalCount: number;
    startAt: Date | null;
    notes: Record<string, string>;
  }): Promise<{ id: string; status: string }>;
  cancelSubscription(id: string): Promise<void>;
  /** checkout's razorpay_signature for an order payment */
  verifyPayment(orderId: string, paymentId: string, signature: string): boolean;
  /** checkout's razorpay_signature for a subscription authorisation */
  verifySubscription(subscriptionId: string, paymentId: string, signature: string): boolean;
  /** the X-Razorpay-Signature header of a webhook, over the raw body */
  verifyWebhook(rawBody: Buffer, signature: string): boolean;
  readonly webhookEnabled: boolean;
}

/** A Razorpay API error, with Razorpay's own description. */
export class RazorpayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RazorpayError";
  }
}

const orderSchema = z.object({ id: z.string(), amount: z.number(), currency: z.string() });
const idSchema = z.object({ id: z.string() });
const subscriptionSchema = z.object({ id: z.string(), status: z.string() });
const errorSchema = z.object({ error: z.object({ description: z.string().optional() }).optional() });

/**
 * Razorpay's REST API over fetch (no SDK): orders for one-off payments, plans and
 * subscriptions for auto-renew, and the three signature checks. Every response is checked
 * with zod before it is used.
 */
export class RazorpayClient implements PaymentGateway {
  readonly keyId: string;
  private readonly authHeader: string;

  constructor(private readonly config: Required<Pick<RazorpayConfig, "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET">> &
    Pick<RazorpayConfig, "RAZORPAY_WEBHOOK_SECRET">) {
    this.keyId = config.RAZORPAY_KEY_ID;
    this.authHeader = `Basic ${Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString("base64")}`;
  }

  /** A client, or null when the keys are not set (billing then answers 503). */
  static fromConfig(config: RazorpayConfig): RazorpayClient | null {
    if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) return null;
    return new RazorpayClient({
      RAZORPAY_KEY_ID: config.RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: config.RAZORPAY_KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: config.RAZORPAY_WEBHOOK_SECRET,
    });
  }

  get webhookEnabled(): boolean {
    return Boolean(this.config.RAZORPAY_WEBHOOK_SECRET);
  }

  async createOrder(input: { amountPaise: number; currency: string; receipt: string; notes: Record<string, string> }) {
    return orderSchema.parse(
      await this.call("POST", "/orders", {
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt.slice(0, 40),
        notes: input.notes,
      }),
    );
  }

  async createPlan(input: { name: string; amountPaise: number; currency: string; intervalMonths: number }) {
    return idSchema.parse(
      await this.call("POST", "/plans", {
        period: "monthly",
        interval: input.intervalMonths,
        item: { name: input.name.slice(0, 100), amount: input.amountPaise, currency: input.currency },
      }),
    );
  }

  async createSubscription(input: { planId: string; totalCount: number; startAt: Date | null; notes: Record<string, string> }) {
    return subscriptionSchema.parse(
      await this.call("POST", "/subscriptions", {
        plan_id: input.planId,
        total_count: input.totalCount,
        customer_notify: 1,
        ...(input.startAt ? { start_at: Math.floor(input.startAt.getTime() / 1000) } : {}),
        notes: input.notes,
      }),
    );
  }

  async cancelSubscription(id: string): Promise<void> {
    await this.call("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 0 });
  }

  verifyPayment(orderId: string, paymentId: string, signature: string): boolean {
    return RazorpayClient.matches(this.config.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`, signature);
  }

  verifySubscription(subscriptionId: string, paymentId: string, signature: string): boolean {
    // Razorpay signs payment id first for subscriptions
    return RazorpayClient.matches(this.config.RAZORPAY_KEY_SECRET, `${paymentId}|${subscriptionId}`, signature);
  }

  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    const secret = this.config.RAZORPAY_WEBHOOK_SECRET;
    return Boolean(secret) && RazorpayClient.matches(secret!, rawBody, signature);
  }

  /** HMAC-SHA256 hex, compared in constant time. */
  static matches(secret: string, payload: string | Buffer, signature: string): boolean {
    const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("hex"));
    const given = Buffer.from(String(signature ?? ""));
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(API + path, {
      method,
      headers: { authorization: this.authHeader, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const parsed = errorSchema.safeParse(data);
      throw new RazorpayError(res.status, parsed.data?.error?.description ?? `Razorpay answered ${res.status}`);
    }
    return data;
  }
}
