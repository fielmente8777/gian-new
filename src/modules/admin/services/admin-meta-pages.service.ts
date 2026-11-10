import type {
  MetaConnectionRecord,
  MetaPageRecord,
  MetaPagesPort,
  PageLink,
  SyncResult,
} from "../../meta-pages/index.js";
import type { ProfileRecord, ProfilesPort } from "../../profiles/index.js";
import {
  ClientNotFoundError,
  MetaConnectionNotFoundError,
  MetaPageNotFoundError,
  MetaPageOutOfScopeError,
  PropertyNotFoundError,
} from "../errors/admin.errors.js";
import type { AdminRecord } from "../types/admin.types.js";
import type { AdminAuditService } from "./admin-audit.service.js";
import { AdminPermissions } from "./admin-permissions.service.js";

/** A client property with the names staff recognise. */
export interface NamedLink extends PageLink {
  hotelName: string | null;
  propertyName: string | null;
}

export interface MetaPageView extends Omit<MetaPageRecord, "link" | "connections"> {
  link: NamedLink | null;
  connections: (Omit<MetaPageRecord["connections"][number], "owner" | "link"> & {
    owner: NamedLink;
    link: NamedLink | null;
  })[];
}

export interface MetaConnectionView extends Omit<MetaConnectionRecord, "owner"> {
  owner: NamedLink;
}

export interface MetaPagesOverview {
  pages: MetaPageView[];
  connections: MetaConnectionView[];
  counts: { pages: number; linked: number; unlinked: number; conflicts: number };
}

/**
 * The Meta pages screen: every Facebook page from every sign-in with Meta, and which client
 * gets its leads. Needs `meta_pages.manage` (an advanced permission). Everyone with it sees
 * every page, because the page to link is usually not linked to anyone yet; an admin can only
 * link to their own properties, and only move pages that are unlinked or already theirs.
 */
export class AdminMetaPagesService {
  constructor(
    private readonly metaPages: MetaPagesPort,
    private readonly profiles: ProfilesPort,
    private readonly audit: AdminAuditService,
  ) {}

  async overview(): Promise<MetaPagesOverview> {
    const [pages, connections] = await Promise.all([this.metaPages.listPages(), this.metaPages.listConnections()]);
    const names = await this.names([
      ...pages.flatMap((p) => [p.link, ...p.connections.flatMap((c) => [c.owner, c.link])]),
      ...connections.map((c) => c.owner),
    ]);
    const linked = pages.filter((p) => p.link).length;
    return {
      pages: pages.map((p) => this.pageView(p, names)),
      connections: connections.map((c) => ({ ...c, owner: AdminMetaPagesService.named(c.owner, names) })),
      counts: {
        pages: pages.length,
        linked,
        unlinked: pages.length - linked,
        conflicts: pages.filter((p) => p.conflict).length,
      },
    };
  }

  async link(admin: AdminRecord, pageId: string, target: PageLink, ip?: string): Promise<MetaPageView> {
    const before = await this.editablePage(admin, pageId);
    const profile = await this.profiles.findByNdid(target.ndid);
    const scope = AdminPermissions.propertyScope(admin);
    // outside the admin's properties looks the same as a client that doesn't exist
    if (!profile || (scope && !scope.has(profile.ndid))) throw new ClientNotFoundError();
    if (!profile.properties.some((p) => p.hid === target.hid) || (scope && !scope.get(profile.ndid)?.has(target.hid))) {
      throw new PropertyNotFoundError();
    }

    const link = { ndid: profile.ndid, hid: target.hid };
    const after = await this.metaPages.setLink(pageId, link);
    if (!after) throw new MetaPageNotFoundError();
    await this.audit.record({
      action: "meta_page.linked",
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: link.ndid,
      changes: { link: { from: before.link, to: link } },
      details: { pageId, pageName: after.name, hid: link.hid, copies: after.connections.length },
      ip: ip ?? null,
    });
    return this.pageView(after, await this.names([after.link, ...after.connections.flatMap((c) => [c.owner, c.link])]));
  }

  async unlink(admin: AdminRecord, pageId: string, ip?: string): Promise<MetaPageView> {
    const before = await this.editablePage(admin, pageId);
    const after = await this.metaPages.setLink(pageId, null);
    if (!after) throw new MetaPageNotFoundError();
    await this.audit.record({
      action: "meta_page.unlinked",
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: before.link?.ndid ?? null,
      changes: { link: { from: before.link, to: null } },
      details: { pageId, pageName: after.name },
      ip: ip ?? null,
    });
    return this.pageView(after, await this.names(after.connections.map((c) => c.owner)));
  }

  async sync(admin: AdminRecord, connectionId: string, ip?: string): Promise<SyncResult> {
    const result = await this.metaPages.sync(connectionId);
    if (!result) throw new MetaConnectionNotFoundError();
    await this.audit.record({
      action: "meta_pages.synced",
      actorId: admin.id,
      actorEmail: admin.email,
      details: {
        connectionId,
        returned: result.returned,
        added: result.added,
        missing: result.missing,
        subscribeFailed: result.subscribeFailed.length,
      },
      ip: ip ?? null,
    });
    return result;
  }

  /** The page, if this person may change its link. */
  private async editablePage(admin: AdminRecord, pageId: string): Promise<MetaPageRecord> {
    const page = await this.metaPages.findPage(pageId);
    if (!page) throw new MetaPageNotFoundError();
    const scope = AdminPermissions.propertyScope(admin);
    if (scope) {
      // every link on any copy must be theirs, or they could take another client's leads
      const links = page.connections.map((c) => c.link).filter((l): l is PageLink => l !== null);
      if (links.some((l) => !scope.get(l.ndid)?.has(l.hid))) throw new MetaPageOutOfScopeError();
    }
    return page;
  }

  private pageView(page: MetaPageRecord, names: Map<string, ProfileRecord>): MetaPageView {
    return {
      ...page,
      link: page.link ? AdminMetaPagesService.named(page.link, names) : null,
      connections: page.connections.map((c) => ({
        ...c,
        owner: AdminMetaPagesService.named(c.owner, names),
        link: c.link ? AdminMetaPagesService.named(c.link, names) : null,
      })),
    };
  }

  /** Profiles of every client mentioned, looked up once. */
  private async names(links: (PageLink | null)[]): Promise<Map<string, ProfileRecord>> {
    const ndids = [...new Set(links.filter((l): l is PageLink => l !== null).map((l) => l.ndid))];
    if (ndids.length === 0) return new Map();
    const page = await this.profiles.list({ ndids, limit: ndids.length });
    return new Map(page.items.map((p) => [p.ndid, p]));
  }

  private static named(link: PageLink, names: Map<string, ProfileRecord>): NamedLink {
    const profile = names.get(link.ndid);
    return {
      ...link,
      hotelName: profile?.hotelName ?? null,
      propertyName: profile?.properties.find((p) => p.hid === link.hid)?.name ?? null,
    };
  }
}
