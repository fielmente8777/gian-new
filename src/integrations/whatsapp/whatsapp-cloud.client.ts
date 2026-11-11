import { z } from "zod";

import type { WhatsappConfig } from "./whatsapp.config.js";

const TIMEOUT_MS = 15_000;

/** What modules depend on to send a WhatsApp message; tests use a fake. */
export interface WhatsappSender {
  /**
   * A pre-approved template message (the only kind Meta lets a business start a chat with).
   * `params` fill {{1}}, {{2}}… of the template body, in order. Returns Meta's message id.
   */
  sendTemplate(input: { to: string; template: string; language: string; params: string[] }): Promise<string>;
}

/** Meta's answer when it refuses a message, e.g. a template that is not approved yet. */
export class WhatsappError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly metaCode: number | null,
  ) {
    super(message);
    this.name = "WhatsappError";
  }
}

const sentSchema = z.object({ messages: z.array(z.object({ id: z.string() })).min(1) });
const errorSchema = z.object({
  error: z.object({ message: z.string().optional(), code: z.number().optional() }).optional(),
});

/**
 * WhatsApp Cloud API over fetch (no SDK): template messages from Eazotel's own number.
 * Phone numbers are sent as digits with the country code; a bare 10-digit Indian number
 * gets 91 in front.
 */
export class WhatsappCloudClient implements WhatsappSender {
  constructor(
    private readonly config: Required<Pick<WhatsappConfig, "WHATSAPP_PHONE_NUMBER_ID" | "WHATSAPP_ACCESS_TOKEN">> &
      Pick<WhatsappConfig, "WHATSAPP_GRAPH_VERSION">,
  ) {}

  /** A client, or null when the number or token is not set (reminders then go by email only). */
  static fromConfig(config: WhatsappConfig): WhatsappCloudClient | null {
    if (!config.WHATSAPP_PHONE_NUMBER_ID || !config.WHATSAPP_ACCESS_TOKEN) return null;
    return new WhatsappCloudClient({
      WHATSAPP_PHONE_NUMBER_ID: config.WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_ACCESS_TOKEN: config.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_GRAPH_VERSION: config.WHATSAPP_GRAPH_VERSION,
    });
  }

  /** "+91 98765-43210" → "919876543210"; "9876543210" → "919876543210"; nonsense → null. */
  static normalisePhone(raw: string | null | undefined): string | null {
    const digits = String(raw ?? "")
      .replace(/\D/g, "")
      .replace(/^0+/, "");
    if (digits.length === 10) return `91${digits}`;
    return digits.length >= 11 && digits.length <= 15 ? digits : null;
  }

  async sendTemplate({
    to,
    template,
    language,
    params,
  }: {
    to: string;
    template: string;
    language: string;
    params: string[];
  }) {
    const url = `https://graph.facebook.com/${this.config.WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(this.config.WHATSAPP_PHONE_NUMBER_ID)}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.WHATSAPP_ACCESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template,
          language: { code: language },
          ...(params.length
            ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] }
            : {}),
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = errorSchema.safeParse(body).data?.error;
      throw new WhatsappError(res.status, error?.message ?? `WhatsApp answered ${res.status}`, error?.code ?? null);
    }
    return sentSchema.parse(body).messages[0]!.id;
  }
}
