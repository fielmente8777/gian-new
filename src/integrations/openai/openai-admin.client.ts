import { ServiceUnavailableError } from "../../shared/errors/http-errors.js";

const COSTS_URL = "https://api.openai.com/v1/organization/costs";
const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;
const MAX_WAIT_MS = 10_000;
/** most daily buckets OpenAI returns per page */
const PAGE_LIMIT = 180;

/** One cost line: one UTC day, one line item (model / feature), one project. */
export interface OpenAiCostRow {
  /** unix seconds, start of the day bucket */
  startTime: number;
  endTime: number;
  lineItem: string;
  projectId: string | null;
  amountUsd: number;
}

interface CostsPage {
  data?: { start_time: number; end_time: number; results?: Record<string, unknown>[] }[];
  has_more?: boolean;
  next_page?: string | null;
}

/**
 * OpenAI could not be read. `upstreamStatus` is OpenAI's HTTP status (null when it never
 * answered). The message never carries the key or OpenAI's response body.
 */
export class OpenAiAdminApiError extends ServiceUnavailableError {
  constructor(
    readonly upstreamStatus: number | null,
    code = "OPENAI_ADMIN_API_FAILED",
    message = "OpenAI's cost data is not available right now",
  ) {
    super(message, { code });
  }
}

/**
 * Reads the organization's costs from OpenAI's Costs API (GET /v1/organization/costs), which
 * needs an Admin key (sk-admin-…), not a normal project key. OpenAI has no endpoint for the
 * prepaid balance itself, so the ai-credits module works the balance out as top-ups recorded
 * by staff minus these costs.
 *
 * Why a class: the key and the fetch function are given once (tests pass a fake fetch), and
 * the paging, retry and error rules live in one place.
 *   - follows every `next_page` cursor until `has_more` is false
 *   - retries 429 and 5xx up to 3 times, waiting Retry-After (capped at 10 s) or 250 ms, 500 ms
 *   - every request times out after 15 s
 *   - any amount not in USD stops the read: dropping it would make spend look smaller
 */
export class OpenAiAdminClient {
  constructor(
    private readonly key: string,
    private readonly request: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Cost lines between two unix times (seconds): start included, end excluded. */
  async costs(startTime: number, endTime: number): Promise<OpenAiCostRow[]> {
    const rows: OpenAiCostRow[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.fetchPage(this.costsUrl(startTime, endTime, cursor));
      for (const bucket of page.data ?? []) {
        for (const item of bucket.results ?? []) rows.push(OpenAiAdminClient.row(bucket, item));
      }
      cursor = page.has_more ? (page.next_page ?? null) : null;
      if (page.has_more && !cursor) throw new OpenAiAdminApiError(null, "OPENAI_COSTS_CURSOR_MISSING");
    } while (cursor);
    return rows;
  }

  private costsUrl(startTime: number, endTime: number, cursor: string | null): URL {
    const url = new URL(COSTS_URL);
    url.searchParams.set("start_time", String(startTime));
    url.searchParams.set("end_time", String(endTime));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.append("group_by", "line_item");
    url.searchParams.append("group_by", "project_id");
    if (cursor) url.searchParams.set("page", cursor);
    return url;
  }

  private async fetchPage(url: URL): Promise<CostsPage> {
    let lastStatus: number | null = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await this.request(url, {
          headers: { Authorization: `Bearer ${this.key}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        // network error or timeout
        lastStatus = null;
        if (attempt < ATTEMPTS) await this.sleep(OpenAiAdminClient.backoff(attempt));
        continue;
      }
      if (response.ok) {
        try {
          return (await response.json()) as CostsPage;
        } catch {
          throw new OpenAiAdminApiError(response.status, "OPENAI_COSTS_UNREADABLE");
        }
      }
      lastStatus = response.status;
      // 401/403 (wrong or non-admin key), 400 (bad query): retrying won't help
      if (response.status !== 429 && response.status < 500) {
        throw new OpenAiAdminApiError(response.status, OpenAiAdminClient.codeFor(response.status));
      }
      if (attempt < ATTEMPTS) await this.sleep(OpenAiAdminClient.retryAfter(response, attempt));
    }
    throw new OpenAiAdminApiError(lastStatus);
  }

  private static row(bucket: { start_time: number; end_time: number }, item: Record<string, unknown>): OpenAiCostRow {
    const amount = item.amount as { value?: unknown; currency?: unknown } | undefined;
    const currency = typeof amount?.currency === "string" ? amount.currency.toLowerCase() : "usd";
    if (currency !== "usd") {
      throw new OpenAiAdminApiError(null, "OPENAI_COST_CURRENCY_UNSUPPORTED", `OpenAI reported a cost in ${currency}`);
    }
    const value = Number(amount?.value ?? 0);
    return {
      startTime: bucket.start_time,
      endTime: bucket.end_time,
      lineItem: typeof item.line_item === "string" && item.line_item ? item.line_item : "unknown",
      projectId: typeof item.project_id === "string" && item.project_id ? item.project_id : null,
      amountUsd: Number.isFinite(value) ? value : 0,
    };
  }

  private static codeFor(status: number): string {
    return status === 401 || status === 403 ? "OPENAI_ADMIN_KEY_REJECTED" : "OPENAI_ADMIN_API_FAILED";
  }

  private static backoff(attempt: number): number {
    return 250 * 2 ** (attempt - 1);
  }

  /** Retry-After in seconds or as a date; otherwise the normal backoff. */
  private static retryAfter(response: Response, attempt: number): number {
    const header = response.headers.get("retry-after");
    if (!header) return OpenAiAdminClient.backoff(attempt);
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    return Math.min(Math.max(Number.isFinite(ms) ? ms : 0, 0), MAX_WAIT_MS);
  }
}
