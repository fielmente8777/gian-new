import { z } from "zod";

const GRAPH = "https://graph.facebook.com/v24.0";
const TIMEOUT_MS = 15_000;
/** /me/accounts pages of 100; an agency account with more than 1,000 pages is not expected */
const MAX_PAGES_OF_RESULTS = 10;

const pageSchema = z.object({
  id: z.string(),
  name: z.string(),
  access_token: z.string(),
  category: z.string().optional(),
  picture: z.unknown().optional(),
  instagram_business_account: z
    .object({
      id: z.string(),
      username: z.string().optional(),
      profile_picture_url: z.string().optional(),
      followers_count: z.number().optional(),
    })
    .optional(),
});
const accountsSchema = z.object({
  data: z.array(pageSchema),
  paging: z.object({ next: z.string().optional() }).optional(),
});
const errorSchema = z.object({ error: z.object({ message: z.string().optional() }).optional() });

/** A page as Meta returns it from /me/accounts. */
export interface GraphPage {
  id: string;
  name: string;
  accessToken: string;
  category: string | null;
  picture: unknown;
  instagram: { igId: string; username: string | null; pictureUrl: string | null; followers: number | null } | null;
}

/** Meta's Graph API, as far as page syncing needs it. Tests use a fake. */
export interface MetaGraph {
  /** every page the token's user granted the app, with page tokens */
  pages(userToken: string): Promise<GraphPage[]>;
  /** subscribes the page to leadgen webhooks; resolves to false with a reason on failure */
  subscribeLeadgen(pageId: string, pageToken: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** A Graph API error, with Meta's own message (e.g. "Error validating access token"). */
export class MetaGraphError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MetaGraphError";
  }
}

/**
 * Meta's Graph API over fetch (no SDK), for the two calls page syncing needs. Every response
 * is checked with zod before it is used. Tokens go in the query string, as Meta expects.
 */
export class MetaGraphClient implements MetaGraph {
  async pages(userToken: string): Promise<GraphPage[]> {
    const fields =
      "id,name,access_token,category,picture,instagram_business_account{id,username,profile_picture_url,followers_count}";
    let url: string | undefined =
      `${GRAPH}/me/accounts?` + new URLSearchParams({ fields, limit: "100", access_token: userToken });
    const pages: GraphPage[] = [];
    for (let i = 0; url && i < MAX_PAGES_OF_RESULTS; i++) {
      const body = accountsSchema.parse(await this.request(url, { method: "GET" }));
      for (const p of body.data) {
        const ig = p.instagram_business_account;
        pages.push({
          id: p.id,
          name: p.name,
          accessToken: p.access_token,
          category: p.category ?? null,
          picture: p.picture ?? null,
          instagram: ig
            ? {
                igId: ig.id,
                username: ig.username ?? null,
                pictureUrl: ig.profile_picture_url ?? null,
                followers: ig.followers_count ?? null,
              }
            : null,
        });
      }
      url = body.paging?.next;
    }
    return pages;
  }

  async subscribeLeadgen(pageId: string, pageToken: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const body = await this.request(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${pageToken}` },
        body: JSON.stringify({ subscribed_fields: "leadgen" }),
      });
      const success = z.object({ success: z.boolean() }).safeParse(body);
      return success.success && success.data.success ? { ok: true } : { ok: false, reason: "Meta did not confirm" };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message = errorSchema.safeParse(body).data?.error?.message ?? `Meta answered ${res.status}`;
      throw new MetaGraphError(res.status, message);
    }
    return body;
  }
}
