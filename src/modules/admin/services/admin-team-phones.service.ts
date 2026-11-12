import type { ClientTrashPort } from "../../client-archive/index.js";
import { LEAD_SOURCES, type HotelNotificationsPort, type PropertyAlerts } from "../../hotel-notifications/index.js";
import type { ProfileRecord, ProfilesPort } from "../../profiles/index.js";
import type { UserRecord, UsersPort } from "../../users/index.js";
import { PhoneNumbers } from "../../../shared/utils/phone-numbers.js";
import { ClientNotFoundError, ClientUserNotFoundError } from "../errors/admin.errors.js";
import type { AdminRecord } from "../types/admin.types.js";
import type { AdminAuditService } from "./admin-audit.service.js";
import { AdminPermissions } from "./admin-permissions.service.js";

/**
 * Whether a team member's number gets the property's WhatsApp lead alerts:
 * hotel_phone = it is the hotel's own phone, which gian always alerts;
 * all / some / none = in every, some or no (property, source) list of extra numbers.
 */
export type AlertCoverage = "hotel_phone" | "all" | "some" | "none";

export interface TeamMemberView {
  id: string;
  name: string | null;
  email: string;
  role: string | null;
  /** the account holder: the tenant's oldest admin */
  isOwner: boolean;
  isAdmin: boolean;
  isActive: boolean;
  phone: string | null;
  /** null while the member has no phone */
  alerts: AlertCoverage | null;
}

export interface ClientTeamView {
  ndid: string;
  hotelName: string | null;
  hotelPhone: string | null;
  /** the hotel phone, ready to copy to the owner; null when it has no country code */
  suggestedOwnerPhone: string | null;
  members: TeamMemberView[];
}

export interface OwnerMissingPhone {
  ndid: string;
  hotelName: string | null;
  ownerId: string;
  ownerEmail: string;
  ownerName: string | null;
  hotelPhone: string | null;
  /** what "Fix" would save; null = no usable hotel phone, staff must type the number */
  suggestedPhone: string | null;
}

/**
 * fixed = the owner's phone was empty and now holds the hotel phone;
 * has_phone = it already had a number (left exactly as it was);
 * no_hotel_phone = the hotel phone is missing or has no country code, so nothing was guessed;
 * not_found = no such client, or no account holder.
 */
export type OwnerPhoneOutcome = "fixed" | "has_phone" | "no_hotel_phone" | "not_found";

export interface OwnerPhoneResult {
  ndid: string;
  hotelName: string | null;
  outcome: OwnerPhoneOutcome;
  ownerEmail: string | null;
  phone: string | null;
  /** (property, source) lists the number was added to */
  alertsAdded: number;
}

/**
 * Fills an account holder's empty phone from the hotel's own phone and puts that number on
 * every lead source's WhatsApp list of each property. Shared by the admin console and
 * scripts/backfill-owner-phones.ts so both follow the same rules:
 * - a phone that is already stored is never replaced (checked again inside the write);
 * - only the account holder is filled; team members have no number to copy;
 * - a hotel phone without a country code is not guessed (gian sends to the stored digits);
 * - alert switches and emails never change; a number already listed (any format) isn't added again.
 */
export class OwnerPhoneFiller {
  constructor(
    private readonly profiles: Pick<ProfilesPort, "findByNdid">,
    private readonly users: Pick<UsersPort, "findOwnerByNdid" | "setPhone">,
    private readonly notifications: Pick<HotelNotificationsPort, "addPhone">,
  ) {}

  /** The value "Fix" saves for this hotel phone, or null when it must be typed by hand. */
  static suggestion(hotelPhone: string | null): string | null {
    return hotelPhone && PhoneNumbers.hasCountryCode(hotelPhone) ? PhoneNumbers.international(hotelPhone) : null;
  }

  /** hids: the properties whose alerts get the number (all of the client's when omitted). */
  async fill(ndid: string, hids?: string[]): Promise<OwnerPhoneResult> {
    const [profile, owner] = await Promise.all([this.profiles.findByNdid(ndid), this.users.findOwnerByNdid(ndid)]);
    const base = { ndid, hotelName: profile?.hotelName ?? null, ownerEmail: owner?.email ?? null, alertsAdded: 0 };
    if (!profile || !owner) return { ...base, outcome: "not_found", phone: null };
    if (owner.phone) return { ...base, outcome: "has_phone", phone: owner.phone };

    const phone = OwnerPhoneFiller.suggestion(profile.hotelPhone);
    if (!phone) return { ...base, outcome: "no_hotel_phone", phone: null };

    const filled = await this.users.setPhone(owner.id, phone, { onlyIfEmpty: true });
    // someone saved a number between the read and the write: theirs stays
    if (!filled) return { ...base, outcome: "has_phone", phone: null };

    const alertsAdded = await this.addToAlerts(profile, phone, hids);
    return { ...base, outcome: "fixed", phone, alertsAdded };
  }

  async addToAlerts(profile: ProfileRecord, phone: string, hids?: string[]): Promise<number> {
    const targets = hids ?? profile.properties.map((p) => p.hid);
    let added = 0;
    for (const hid of targets) added += (await this.notifications.addPhone(profile.ndid, hid, phone)).length;
    return added;
  }
}

/**
 * The client's team (Zucks_users) and their WhatsApp numbers, for staff: see who has none,
 * type or correct a number, and fill account holders' empty phones from the hotel phone.
 * Scoped like the clients screens: a client outside someone's properties is "not found".
 */
export class AdminTeamPhonesService {
  private readonly filler: OwnerPhoneFiller;

  constructor(
    private readonly profiles: Pick<ProfilesPort, "findByNdid">,
    private readonly users: Pick<UsersPort, "findOwnerByNdid" | "setPhone" | "listByNdid" | "ownersWithoutPhone">,
    private readonly notifications: Pick<HotelNotificationsPort, "addPhone" | "list">,
    private readonly trash: Pick<ClientTrashPort, "ndids">,
    private readonly audit: AdminAuditService,
  ) {
    this.filler = new OwnerPhoneFiller(profiles, users, notifications);
  }

  async team(admin: AdminRecord, ndid: string): Promise<ClientTeamView> {
    const { profile, hids } = await this.findVisible(admin, ndid);
    const [members, alerts] = await Promise.all([
      this.users.listByNdid(profile.ndid),
      this.notifications.list(profile.ndid, hids),
    ]);
    const ownerId = members.find((m) => m.isAdmin)?.id ?? null;
    return {
      ndid: profile.ndid,
      hotelName: profile.hotelName,
      hotelPhone: profile.hotelPhone,
      suggestedOwnerPhone: OwnerPhoneFiller.suggestion(profile.hotelPhone),
      members: members
        .map((m) => AdminTeamPhonesService.memberView(m, m.id === ownerId, profile.hotelPhone, alerts))
        // owner first, then admins, then by name
        .sort(
          (a, b) =>
            Number(b.isOwner) - Number(a.isOwner) ||
            Number(b.isAdmin) - Number(a.isAdmin) ||
            (a.name ?? a.email).localeCompare(b.name ?? b.email),
        ),
    };
  }

  /**
   * Saves one member's phone (null clears it) and, with addToAlerts, puts it on every lead
   * source's WhatsApp list of the properties this person may see. Logged.
   */
  async setPhone(
    admin: AdminRecord,
    ndid: string,
    userId: string,
    phone: string | null,
    addToAlerts: boolean,
    ip?: string,
  ): Promise<ClientTeamView> {
    const { profile, hids } = await this.findVisible(admin, ndid);
    const member = (await this.users.listByNdid(profile.ndid)).find((m) => m.id === userId);
    if (!member) throw new ClientUserNotFoundError();

    const changed = member.phone !== phone && (await this.users.setPhone(member.id, phone));
    const alertsAdded = phone && addToAlerts ? await this.filler.addToAlerts(profile, phone, hids) : 0;
    if (changed || alertsAdded > 0) {
      await this.audit.record({
        action: "client.team_phone_changed",
        actorId: admin.id,
        actorEmail: admin.email,
        targetId: profile.ndid,
        targetEmail: member.email,
        changes: changed ? { phone: { from: member.phone, to: phone } } : {},
        details: { hotelName: profile.hotelName, member: member.email, alertListsAdded: alertsAdded },
        ip,
      });
    }
    return this.team(admin, ndid);
  }

  /**
   * Account holders with no phone, within this person's properties, leaving out clients in
   * the trash. suggestedPhone is what fixOwners would save.
   */
  async ownersMissingPhone(admin: AdminRecord, limit = 500): Promise<OwnerMissingPhone[]> {
    const scope = AdminPermissions.propertyScope(admin);
    if (scope?.size === 0) return [];
    const trashed = new Set(await this.trash.ndids());
    const owners = (await this.users.ownersWithoutPhone(limit)).filter(
      (o): o is UserRecord & { ndid: string } => !!o.ndid && !trashed.has(o.ndid) && (!scope || scope.has(o.ndid)),
    );

    const rows: OwnerMissingPhone[] = [];
    // 20 profiles at a time keeps the database calm on a long list
    for (let i = 0; i < owners.length; i += 20) {
      const batch = owners.slice(i, i + 20);
      const profiles = await Promise.all(batch.map((o) => this.profiles.findByNdid(o.ndid)));
      batch.forEach((owner, j) => {
        const profile = profiles[j];
        // an account that never finished onboarding has no hotel yet: nothing to fix
        if (!profile) return;
        rows.push({
          ndid: owner.ndid,
          hotelName: profile.hotelName,
          ownerId: owner.id,
          ownerEmail: owner.email,
          ownerName: owner.displayName ?? owner.userName,
          hotelPhone: profile.hotelPhone,
          suggestedPhone: OwnerPhoneFiller.suggestion(profile.hotelPhone),
        });
      });
    }
    return rows;
  }

  /** Fills each listed client's empty owner phone from its hotel phone. One audit entry per fix. */
  async fixOwners(admin: AdminRecord, ndids: string[], ip?: string): Promise<OwnerPhoneResult[]> {
    const scope = AdminPermissions.propertyScope(admin);
    const results: OwnerPhoneResult[] = [];
    for (const ndid of [...new Set(ndids)]) {
      if (scope && !scope.has(ndid)) {
        results.push({ ndid, hotelName: null, outcome: "not_found", ownerEmail: null, phone: null, alertsAdded: 0 });
        continue;
      }
      const hids = scope ? [...scope.get(ndid)!] : undefined;
      const result = await this.filler.fill(ndid, hids);
      results.push(result);
      if (result.outcome === "fixed") {
        await this.audit.record({
          action: "client.owner_phone_filled",
          actorId: admin.id,
          actorEmail: admin.email,
          targetId: ndid,
          targetEmail: result.ownerEmail,
          changes: { phone: { from: null, to: result.phone } },
          details: { hotelName: result.hotelName, alertListsAdded: result.alertsAdded, from: "hotel phone" },
          ip,
        });
      }
    }
    return results;
  }

  private async findVisible(admin: AdminRecord, ndid: string): Promise<{ profile: ProfileRecord; hids: string[] }> {
    const scope = AdminPermissions.propertyScope(admin);
    if (scope && !scope.has(ndid)) throw new ClientNotFoundError();
    const profile = await this.profiles.findByNdid(ndid);
    if (!profile) throw new ClientNotFoundError();
    const allowed = scope?.get(ndid);
    const hids = profile.properties.map((p) => p.hid).filter((hid) => !allowed || allowed.has(hid));
    return { profile, hids };
  }

  private static memberView(
    member: UserRecord,
    isOwner: boolean,
    hotelPhone: string | null,
    alerts: PropertyAlerts[],
  ): TeamMemberView {
    return {
      id: member.id,
      name: member.displayName ?? member.userName,
      email: member.email,
      role: member.role,
      isOwner,
      isAdmin: member.isAdmin,
      isActive: member.isActive,
      phone: member.phone,
      alerts: member.phone ? AdminTeamPhonesService.coverage(member.phone, hotelPhone, alerts) : null,
    };
  }

  private static coverage(phone: string, hotelPhone: string | null, alerts: PropertyAlerts[]): AlertCoverage {
    if (PhoneNumbers.same(phone, hotelPhone)) return "hotel_phone";
    const cells = alerts.flatMap((p) => LEAD_SOURCES.map((s) => p.sources[s].phones));
    const listed = cells.filter((phones) => phones.some((p) => PhoneNumbers.same(p, phone))).length;
    if (cells.length > 0 && listed === cells.length) return "all";
    return listed > 0 ? "some" : "none";
  }
}
