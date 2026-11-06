import type { RefreshTokenService } from "../../auth/index.js";
import {
  CannotChangeOwnAccessError,
  SuperAdminMinimumError,
  TeamMemberExistsError,
  TeamMemberNotFoundError,
} from "../errors/admin.errors.js";
import type {
  AdminRecord,
  AdminUserStore,
  AssignedProperty,
  AuditChanges,
  NewTeamMember,
  TeamMemberChanges,
} from "../types/admin.types.js";
import type { AdminAuditService } from "./admin-audit.service.js";

const MINIMUM_SUPER_ADMINS = 2;

/** Who did it and from where, for the audit log. */
export interface TeamAction {
  actor: AdminRecord;
  ip?: string;
}

/**
 * Adds and changes staff. The team cannot lock itself out: nobody can change their own role or
 * status, and removing a super admin must leave MINIMUM_SUPER_ADMINS. The count is not atomic,
 * so two removals at the same moment could leave one fewer, but never zero, because each
 * person doing a removal cannot remove themselves.
 */
export class AdminTeamService {
  constructor(
    private readonly admins: AdminUserStore,
    private readonly audit: AdminAuditService,
    private readonly refreshTokens: Pick<RefreshTokenService, "revokeAllForUser">,
  ) {}

  list(): Promise<AdminRecord[]> {
    return this.admins.list();
  }

  async add(input: NewTeamMember, { actor, ip }: TeamAction): Promise<AdminRecord> {
    const member = await this.admins.create(AdminTeamService.normalize(input));
    if (!member) throw new TeamMemberExistsError();

    await this.audit.record({
      action: "team.member_added",
      ...AdminTeamService.parties(actor, member),
      details: { role: member.role },
      ip,
    });
    return member;
  }

  async update(id: string, requested: TeamMemberChanges, { actor, ip }: TeamAction): Promise<AdminRecord> {
    const target = await this.admins.findById(id);
    if (!target) throw new TeamMemberNotFoundError();

    const changes = AdminTeamService.onlyDifferences(target, AdminTeamService.normalize(requested));
    if (Object.keys(changes).length === 0) return target;
    await this.assertAllowed(actor, target, changes);

    const updated = await this.admins.update(id, changes);
    if (!updated) throw new TeamMemberNotFoundError();

    // Otherwise turning them back on later would quietly bring back their old browser sessions.
    if (changes.status === "disabled") await this.refreshTokens.revokeAllForUser(id, "inactive");

    await this.audit.record({
      action: "team.member_updated",
      ...AdminTeamService.parties(actor, updated),
      changes: AdminTeamService.describe(target, changes),
      ip,
    });
    return updated;
  }

  private async assertAllowed(actor: AdminRecord, target: AdminRecord, changes: TeamMemberChanges): Promise<void> {
    const changesAccess = changes.role !== undefined || changes.status !== undefined;
    if (actor.id === target.id && changesAccess) throw new CannotChangeOwnAccessError();

    const isActiveSuperAdmin = target.role === "super_admin" && target.status === "active";
    const stopsBeingOne = changes.role === "admin" || changes.status === "disabled";
    if (isActiveSuperAdmin && stopsBeingOne) {
      const remaining = (await this.admins.countActiveSuperAdmins()) - 1;
      if (remaining < MINIMUM_SUPER_ADMINS) throw new SuperAdminMinimumError(MINIMUM_SUPER_ADMINS);
    }
  }

  private static normalize<T extends TeamMemberChanges>(input: T): T {
    return {
      ...input,
      ...(input.name !== undefined ? { name: input.name || null } : {}),
      ...(input.advancedPermissions ? { advancedPermissions: [...new Set(input.advancedPermissions)] } : {}),
      ...(input.assignedProperties
        ? { assignedProperties: AdminTeamService.uniqueProperties(input.assignedProperties) }
        : {}),
    };
  }

  private static uniqueProperties(properties: AssignedProperty[]): AssignedProperty[] {
    const byKey = new Map(properties.map(({ ndid, hid }) => [`${ndid}\n${hid}`, { ndid, hid }]));
    return [...byKey.values()];
  }

  private static onlyDifferences(target: AdminRecord, requested: TeamMemberChanges): TeamMemberChanges {
    const entries = Object.entries(requested).filter(
      ([key, value]) =>
        value !== undefined && JSON.stringify(value) !== JSON.stringify(target[key as keyof AdminRecord]),
    );
    return Object.fromEntries(entries);
  }

  private static describe(target: AdminRecord, changes: TeamMemberChanges): AuditChanges {
    return Object.fromEntries(
      Object.entries(changes).map(([key, to]) => [key, { from: target[key as keyof AdminRecord], to }]),
    );
  }

  private static parties(actor: AdminRecord, target: AdminRecord) {
    return { actorId: actor.id, actorEmail: actor.email, targetId: target.id, targetEmail: target.email };
  }
}
