import type { UsersPort } from "../../users/index.js";

const CACHE_MS = 60_000;

/** clients = real hotels; test = Eazotel's own dashboards (owner or hotel email on an Eazotel domain). */
export type ListKind = "clients" | "test";

/** What a list query needs to show one kind: only these ndids, never those, or nothing at all. */
export interface KindFilter {
  ndids?: string[];
  excludeNdids?: string[];
  /** nothing can match (e.g. an admin none of whose properties is a test account) */
  empty: boolean;
}

/**
 * The team creates dashboards with @eazotel.com / @fielmente.com logins to try things out. They
 * are kept apart from real clients: the Clients and Subscriptions screens show real ones by
 * default and the test ones under a Test tab. Only the account holder's own login email counts
 * (ADMIN_TEST_EMAIL_DOMAINS): a real hotel with an Eazotel team member, or an Eazotel address
 * as its hotel or marketing email, stays a client. Read at most once a minute.
 *
 * Also finds clients by any login email, for the lists' search box.
 */
export class AdminTestAccounts {
  private cache: { at: number; ndids: string[] } | null = null;

  constructor(
    private readonly users: Pick<UsersPort, "ownerNdidsWithEmailDomains" | "ndidsByEmail">,
    private readonly domains: string[],
    private readonly cacheMs = CACHE_MS,
  ) {}

  async ndids(): Promise<string[]> {
    if (this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.ndids;
    if (!this.domains.length) return [];
    const ndids = [...new Set(await this.users.ownerNdidsWithEmailDomains(this.domains))];
    this.cache = { at: Date.now(), ndids };
    return ndids;
  }

  /** Clients with a login email containing the search text (3+ characters). */
  searchByEmail(search: string | undefined): Promise<string[]> {
    return search && search.trim().length >= 3 ? this.users.ndidsByEmail(search, 200) : Promise.resolve([]);
  }

  /** The filter for one kind, within the person's properties (`scope`), leaving out the trash (`hidden`). */
  async filter(kind: ListKind, scope: Map<string, Set<string>> | null, hidden: string[]): Promise<KindFilter> {
    const test = await this.ndids();
    if (kind === "test") {
      const ndids = scope ? test.filter((n) => scope.has(n)) : test;
      return { ndids, ...(hidden.length ? { excludeNdids: hidden } : {}), empty: ndids.length === 0 };
    }
    const excludeNdids = [...new Set([...hidden, ...test])];
    return {
      ...(scope ? { ndids: [...scope.keys()] } : {}),
      ...(excludeNdids.length ? { excludeNdids } : {}),
      empty: false,
    };
  }
}
