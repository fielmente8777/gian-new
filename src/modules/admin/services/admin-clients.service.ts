import type { AdminTestAccounts, ListKind } from "./admin-test-accounts.js";
import type { ClientAccountToken } from "../../auth/index.js";
import type {
  ClientServiceName,
  ClientServicesPort,
  EffectiveServices,
  ReleasedLeads,
  ServiceEnforcer,
} from "../../client-services/index.js";
import type {
  ClientArchivePort,
  DeletionPreview,
  DeletionResult,
  ClientTrashPort,
  TrashedClient,
} from "../../client-archive/index.js";
import {
  LEAD_SOURCES,
  type HotelNotificationsPort,
  type LeadSource,
  type PropertyAlerts,
  type SourceAlertsMap,
} from "../../hotel-notifications/index.js";
import type { UsersPort } from "../../users/index.js";
import type { ProfileChanges, ProfilePage, ProfileRecord, ProfilesPort } from "../../profiles/index.js";
import {
  ClientAccountInactiveError,
  ClientAccountNotFoundError,
  ClientNotFoundError,
  DeleteConfirmationError,
  PropertyNotFoundError,
} from "../errors/admin.errors.js";
import type { AdminRecord, AuditChanges } from "../types/admin.types.js";
import type { AdminAuditService } from "./admin-audit.service.js";
import { AdminPermissions } from "./admin-permissions.service.js";

/** A client as staff see it: the profile plus whoever holds the hotel's account. */
export interface ClientView {
  profile: ProfileRecord;
  owner: { email: string; name: string | null; phone: string | null; isActive: boolean } | null;
  /** set while the client is in the trash */
  trash: TrashedClient | null;
}

/** A short sign-in for the hotel dashboard, as the client. */
export interface OpenedAccount extends ClientAccountToken {
  ndid: string;
  /** the property the dashboard should open on: the first one this person may see */
  hid: string | null;
  accountEmail: string;
}

export interface ClientAccountIssuer {
  issue(accountEmail: string): Promise<ClientAccountToken>;
}

/** A client's switchable services, what actually runs, and the leads waiting for the hotel. */
export interface ClientServicesView extends EffectiveServices {
  /** leads the hotel hasn't been told about yet */
  heldLeads: number;
  /** set right after leads could be delivered again */
  released?: ReleasedLeads;
  emailed?: number;
}

/** What the clients and subscriptions screens need from the client-services module. */
export interface ServiceControl {
  store: Pick<ClientServicesPort, "set" | "countPendingAlerts">;
  enforcer: Pick<ServiceEnforcer, "effective" | "apply">;
}

/** A client's lead alerts, per property, and whether alerts can go out at all. */
export interface ClientNotificationsView {
  hotelEmail: string | null;
  hotelPhone: string | null;
  /** false while the Leads switch is off or the subscription is stopped: nothing is sent */
  leadsDelivered: boolean;
  subscriptionServing: boolean;
  properties: (PropertyAlerts & { name: string | null })[];
}

/** How the audit log names each lead source. */
const SOURCE_LABELS: Record<LeadSource, string> = {
  webform: "website form",
  eazbot: "chatbot",
  whatsapp: "WhatsApp chat",
  facebook: "Meta ads",
  google: "Google Ads",
};

export interface ClientListQuery {
  limit: number;
  after?: string;
  search?: string;
  /** clients (default) = real hotels; test = Eazotel's own test dashboards */
  kind?: ListKind;
}

/**
 * Lets staff find, view and edit hotel clients, only within the properties they hold. A
 * client or property outside someone's scope answers "not found", so nobody can probe which
 * clients exist.
 *
 * The hotel name is not editable here: nexon still finds a profile by matching it against
 * the booking engine's own copy, so renaming one side alone would break that.
 */
export class AdminClientsService {
  constructor(
    private readonly profiles: ProfilesPort,
    private readonly users: Pick<UsersPort, "findOwnerByNdid">,
    private readonly audit: AdminAuditService,
    private readonly accounts: ClientAccountIssuer,
    private readonly control: ServiceControl,
    private readonly archive: ClientArchivePort,
    private readonly notifications: HotelNotificationsPort,
    private readonly trash: Pick<ClientTrashPort, "find" | "ndids">,
    private readonly testAccounts: Pick<AdminTestAccounts, "filter" | "searchByEmail">,
  ) {}

  async list(admin: AdminRecord, query: ClientListQuery): Promise<ProfilePage> {
    const scope = AdminPermissions.propertyScope(admin);
    if (scope?.size === 0) return { items: [], nextCursor: null };
    const { kind = "clients", ...search } = query;
    const filter = await this.testAccounts.filter(kind, scope, await this.trash.ndids());
    if (filter.empty) return { items: [], nextCursor: null };
    const byEmail = await this.testAccounts.searchByEmail(search.search);
    const page = await this.profiles.list({
      ...search,
      ...(byEmail.length ? { orNdids: byEmail } : {}),
      ...(filter.ndids ? { ndids: filter.ndids } : {}),
      ...(filter.excludeNdids ? { excludeNdids: filter.excludeNdids } : {}),
    });
    return { ...page, items: page.items.map((profile) => AdminClientsService.limitTo(profile, scope)) };
  }

  async get(admin: AdminRecord, ndid: string): Promise<ClientView> {
    const profile = await this.findVisible(admin, ndid);
    const [owner, trash] = await Promise.all([this.users.findOwnerByNdid(profile.ndid), this.trash.find(profile.ndid)]);
    return {
      trash,
      profile,
      owner: owner
        ? {
            email: owner.email,
            name: owner.displayName ?? owner.userName,
            phone: owner.phone,
            isActive: owner.isActive,
          }
        : null,
    };
  }

  async update(admin: AdminRecord, ndid: string, requested: ProfileChanges, ip?: string): Promise<ClientView> {
    const before = await this.findVisible(admin, ndid);
    const visible = new Set(before.properties.map((p) => p.hid));
    if (Object.keys(requested.properties).some((hid) => !visible.has(hid))) throw new PropertyNotFoundError();

    const { changes, described } = AdminClientsService.differences(before, requested);
    if (Object.keys(described).length > 0) {
      const updated = await this.profiles.update(before.ndid, changes);
      if (!updated) throw new ClientNotFoundError();
      await this.audit.record({
        action: "client.updated",
        actorId: admin.id,
        actorEmail: admin.email,
        targetId: before.ndid,
        targetEmail: before.hotelEmail,
        changes: described,
        details: { hotelName: before.hotelName },
        ip,
      });
    }
    return this.get(admin, ndid);
  }

  /**
   * Signs this person in to the hotel dashboard as the client, for AUTH_IMPERSONATION_TTL.
   * The route already required clients.open_account; the client must be within their
   * properties, and the log says who opened which account.
   */
  async openAccount(admin: AdminRecord, ndid: string, ip?: string): Promise<OpenedAccount> {
    const profile = await this.findVisible(admin, ndid);
    const owner = await this.users.findOwnerByNdid(profile.ndid);
    if (!owner) throw new ClientAccountNotFoundError();
    if (!owner.isActive) throw new ClientAccountInactiveError();

    const access = await this.accounts.issue(owner.email);
    await this.audit.record({
      action: "client.account_opened",
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: profile.ndid,
      targetEmail: owner.email,
      details: { hotelName: profile.hotelName, expiresAt: access.expiresAt.toISOString() },
      ip,
    });
    return {
      ...access,
      ndid: profile.ndid,
      hid: profile.properties[0]?.hid ?? null,
      accountEmail: owner.email,
    };
  }

  async getServices(admin: AdminRecord, ndid: string): Promise<ClientServicesView> {
    const profile = await this.findVisible(admin, ndid);
    return this.servicesView(profile.ndid);
  }

  /**
   * Switches a service on or off, then makes it so at once (see ServiceEnforcer): the chatbot
   * hides or comes back, and when leads can be delivered again the held ones move into the
   * dashboard with one catch-up email. A stopped subscription keeps both off whatever the switch says.
   */
  async setService(
    admin: AdminRecord,
    ndid: string,
    service: ClientServiceName,
    enabled: boolean,
    ip?: string,
  ): Promise<ClientServicesView> {
    const profile = await this.findVisible(admin, ndid);
    const before = await this.control.enforcer.effective(profile.ndid);
    const changed = before.switches[service].enabled !== enabled;
    if (changed) await this.control.store.set(profile.ndid, service, enabled, admin.email);
    const applied = await this.control.enforcer.apply(profile.ndid);

    if (changed) {
      await this.audit.record({
        action: "client.service_changed",
        actorId: admin.id,
        actorEmail: admin.email,
        targetId: profile.ndid,
        targetEmail: profile.hotelEmail,
        changes: { [service]: { from: before.switches[service].enabled ? "on" : "off", to: enabled ? "on" : "off" } },
        details: {
          hotelName: profile.hotelName,
          service,
          ...(applied.released ? { releasedLeads: applied.released.leads, emailedLeads: applied.emailed } : {}),
        },
        ip,
      });
    }
    return {
      ...(await this.servicesView(profile.ndid)),
      ...(applied.released ? { released: applied.released, emailed: applied.emailed } : {}),
    };
  }

  /**
   * The lead alerts of each property this person may see: the same settings the hotel edits
   * in its dashboard. Whether any alert goes out at all still depends on the Leads switch and
   * the subscription (leadsDelivered).
   */
  async getNotifications(admin: AdminRecord, ndid: string): Promise<ClientNotificationsView> {
    const profile = await this.findVisible(admin, ndid);
    return this.notificationsView(profile);
  }

  /** Saves every source of one property's lead alerts. Logs only what really changed. */
  async saveNotifications(
    admin: AdminRecord,
    ndid: string,
    hid: string,
    sources: SourceAlertsMap,
    ip?: string,
  ): Promise<ClientNotificationsView> {
    const profile = await this.findVisible(admin, ndid);
    const property = profile.properties.find((p) => p.hid === hid);
    if (!property) throw new PropertyNotFoundError();

    const [before] = await this.notifications.list(profile.ndid, [hid]);
    const changes = AdminClientsService.alertChanges(before!.sources, sources);
    // an unsaved property is saved even without changes, so gian stops using its defaults
    if (Object.keys(changes).length > 0 || !before!.saved) {
      await this.notifications.save(profile.ndid, hid, sources);
      await this.audit.record({
        action: "client.notifications_changed",
        actorId: admin.id,
        actorEmail: admin.email,
        targetId: profile.ndid,
        targetEmail: profile.hotelEmail,
        changes,
        details: { hotelName: profile.hotelName, hid, property: property.name },
        ip,
      });
    }
    return this.notificationsView(profile);
  }

  /** What a delete would remove, collection by collection. */
  async deletionPreview(admin: AdminRecord, ndid: string): Promise<DeletionPreview & { hotelName: string | null }> {
    const profile = await this.findVisible(admin, ndid);
    return { ...(await this.archive.preview(profile.ndid)), hotelName: profile.hotelName };
  }

  /**
   * Deletes every record of the client, after copying each to the archive. The caller must
   * type the hotel's name (or the ndid when it has none) to confirm. Logged.
   */
  async delete(
    admin: AdminRecord,
    ndid: string,
    confirmName: string,
    reason: string | null,
    ip?: string,
  ): Promise<DeletionResult> {
    const profile = await this.findVisible(admin, ndid);
    const expected = profile.hotelName?.trim() || profile.ndid;
    const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
    if (normalize(confirmName) !== normalize(expected)) throw new DeleteConfirmationError();

    const result = await this.archive.archiveAndDelete(profile.ndid, {
      hotelName: profile.hotelName,
      by: admin.email,
      reason,
    });
    await this.audit.record({
      action: "client.deleted",
      actorId: admin.id,
      actorEmail: admin.email,
      targetId: profile.ndid,
      targetEmail: profile.hotelEmail,
      details: {
        hotelName: profile.hotelName,
        deletionId: result.deletionId,
        records: result.total,
        collections: Object.fromEntries(result.collections.map((c) => [c.collection, c.count])),
        ...(reason ? { reason } : {}),
      },
      ip,
    });
    return result;
  }

  private async notificationsView(profile: ProfileRecord): Promise<ClientNotificationsView> {
    const [effective, saved] = await Promise.all([
      this.control.enforcer.effective(profile.ndid),
      this.notifications.list(
        profile.ndid,
        profile.properties.map((p) => p.hid),
      ),
    ]);
    return {
      hotelEmail: profile.hotelEmail,
      hotelPhone: profile.hotelPhone,
      leadsDelivered: effective.leads,
      subscriptionServing: effective.subscriptionServing,
      properties: saved.map((alerts, i) => ({ ...alerts, name: profile.properties[i]?.name ?? null })),
    };
  }

  /** "website form email": { from: "off", to: "on" }, and the extra addresses that changed. */
  private static alertChanges(before: SourceAlertsMap, after: SourceAlertsMap): AuditChanges {
    const changes: AuditChanges = {};
    const onOff = (v: boolean) => (v ? "on" : "off");
    const list = (v: string[]) => (v.length ? v.join(", ") : null);
    for (const source of LEAD_SOURCES) {
      const label = SOURCE_LABELS[source];
      const [b, a] = [before[source], after[source]];
      if (b.email !== a.email) changes[`${label} email`] = { from: onOff(b.email), to: onOff(a.email) };
      if (list(b.emails) !== list(a.emails))
        changes[`${label} extra emails`] = { from: list(b.emails), to: list(a.emails) };
      if (b.whatsapp !== a.whatsapp) changes[`${label} WhatsApp`] = { from: onOff(b.whatsapp), to: onOff(a.whatsapp) };
      if (list(b.phones) !== list(a.phones))
        changes[`${label} extra numbers`] = { from: list(b.phones), to: list(a.phones) };
    }
    return changes;
  }

  private async servicesView(ndid: string): Promise<ClientServicesView> {
    const [effective, heldLeads] = await Promise.all([
      this.control.enforcer.effective(ndid),
      this.control.store.countPendingAlerts(ndid),
    ]);
    return { ...effective, heldLeads };
  }

  private async findVisible(admin: AdminRecord, ndid: string): Promise<ProfileRecord> {
    const scope = AdminPermissions.propertyScope(admin);
    if (scope && !scope.has(ndid)) throw new ClientNotFoundError();
    const profile = await this.profiles.findByNdid(ndid);
    if (!profile) throw new ClientNotFoundError();
    return AdminClientsService.limitTo(profile, scope);
  }

  private static limitTo(profile: ProfileRecord, scope: Map<string, Set<string>> | null): ProfileRecord {
    const hids = scope?.get(profile.ndid);
    return hids ? { ...profile, properties: profile.properties.filter((p) => hids.has(p.hid)) } : profile;
  }

  /** Keeps only real changes, and describes them for the audit log as "field" or "property <hid> field". */
  private static differences(
    before: ProfileRecord,
    requested: ProfileChanges,
  ): { changes: ProfileChanges; described: AuditChanges } {
    const changes: ProfileChanges = { profile: {}, properties: {} };
    const described: AuditChanges = {};

    for (const [field, to] of Object.entries(requested.profile)) {
      const from = before[field as keyof typeof requested.profile];
      if ((to ?? null) === from) continue;
      changes.profile[field as keyof typeof requested.profile] = to ?? null;
      described[field] = { from, to: to ?? null };
    }
    for (const [hid, fields] of Object.entries(requested.properties)) {
      const property = before.properties.find((p) => p.hid === hid);
      for (const [field, to] of Object.entries(fields)) {
        const from = property?.[field as keyof typeof fields] ?? null;
        if ((to ?? null) === from) continue;
        (changes.properties[hid] ??= {})[field as keyof typeof fields] = to ?? null;
        described[`property ${hid} ${field}`] = { from, to: to ?? null };
      }
    }
    return { changes, described };
  }
}
