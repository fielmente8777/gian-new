import type { ZohoBooksApi, ZohoContact } from "../../../integrations/zoho/zoho-books.client.js";
import { ZohoNotConnectedError } from "../errors/billing.errors.js";
import type { ZohoCustomerLink, ZohoStore } from "../types/zoho.types.js";
import type { ZohoConnectionService } from "./zoho-connection.service.js";
import type { ZohoInvoicingService } from "./zoho-invoicing.service.js";

const CACHE_MS = 5 * 60_000;
/** 10 pages × 200: far more customers than Eazotel has */
const MAX_PAGES = 10;

/**
 * Zoho Books customers and which client each one is. The team links them once in the admin
 * console (e.g. Zoho's "Green Castle Resort" → Greencastle's ndid); after that every invoice of
 * that customer is known to be that client's.
 */
export class ZohoCustomersService {
  private cache: { at: number; items: ZohoContact[] } | null = null;

  constructor(
    private readonly connection: ZohoConnectionService,
    private readonly api: ZohoBooksApi | null,
    private readonly store: ZohoStore,
    private readonly invoicing: ZohoInvoicingService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every Zoho customer, read at most every 5 minutes. */
  async all(fresh = false): Promise<ZohoContact[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.items;
    const { connection, access } = await this.connection.session();
    const items: ZohoContact[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.api!.contacts(access, connection.orgId, { page });
      items.push(...result.items);
      if (!result.hasMore) break;
    }
    this.cache = { at: Date.now(), items };
    return items;
  }

  links(): Promise<ZohoCustomerLink[]> {
    return this.store.links();
  }

  linkOf(ndid: string): Promise<ZohoCustomerLink | null> {
    return this.store.linkByNdid(ndid);
  }

  /** Ties a Zoho customer to a client; either one's earlier link is replaced. */
  async link(ndid: string, contactId: string, by: string): Promise<ZohoCustomerLink> {
    let contact = (await this.all()).find((c) => c.contactId === contactId);
    if (!contact) contact = (await this.all(true)).find((c) => c.contactId === contactId);
    if (!contact) throw new ZohoNotConnectedError("That customer is not in Zoho Books");
    const link: ZohoCustomerLink = { ndid, contactId, contactName: contact.name, linkedBy: by, linkedAt: this.now() };
    await this.store.saveLink(link);
    return link;
  }

  unlink(ndid: string): Promise<boolean> {
    return this.store.deleteLink(ndid);
  }

  /** Makes a Zoho customer from the client's profile and links it. */
  async create(ndid: string, by: string): Promise<ZohoCustomerLink> {
    const link = await this.invoicing.customerFor(ndid, by);
    this.cache = null;
    return link;
  }
}
