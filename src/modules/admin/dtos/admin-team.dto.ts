import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import { ADMIN_ADVANCED_PERMISSIONS } from "../constants/admin-permissions.js";
import type { AdminRecord } from "../types/admin.types.js";

const name = z.string().trim().max(120);
const role = z.enum(["super_admin", "admin"]);
const status = z.enum(["active", "disabled"]);
const advancedPermissions = z.array(z.enum(ADMIN_ADVANCED_PERMISSIONS));
const propertyCode = z.string().trim().min(1, "Enter both codes for each property").max(128);
const assignedProperties = z.array(z.object({ ndid: propertyCode, hid: propertyCode }));

export class AddTeamMemberDto extends BaseDto {
  static override readonly schema = z.object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email({ error: "Enter a valid email address" }).max(254))
      .meta({ format: "email", example: "someone@eazotel.com" }),
    name: name.nullable().default(null),
    role: role.default("admin"),
    advancedPermissions: advancedPermissions.default([]),
    assignedProperties: assignedProperties.default([]),
  });
}
export type AddTeamMemberBody = z.infer<typeof AddTeamMemberDto.schema>;

export class UpdateTeamMemberDto extends BaseDto {
  static override readonly schema = z
    .object({
      name: name.nullable().optional(),
      role: role.optional(),
      status: status.optional(),
      advancedPermissions: advancedPermissions.optional(),
      assignedProperties: assignedProperties.optional(),
    })
    .refine((changes) => Object.keys(changes).length > 0, { error: "Send at least one field to change" });
}
export type UpdateTeamMemberBody = z.infer<typeof UpdateTeamMemberDto.schema>;

export class TeamMemberParamsDto extends BaseDto {
  static override readonly schema = z.object({
    id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid staff member id"),
  });
}
export type TeamMemberParams = z.infer<typeof TeamMemberParamsDto.schema>;

// ── responses ───────────────────────────────────────────────────────────────

export const teamMemberSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role,
  status,
  googleLinked: z.boolean().meta({ description: "false until their first sign-in finishes" }),
  advancedPermissions: z.array(z.string()),
  assignedProperties: z.array(z.object({ ndid: z.string(), hid: z.string() })),
  lastLoginAt: z.iso.datetime().nullable(),
});

export const invitedMemberSchema = teamMemberSchema.extend({
  inviteSent: z
    .boolean()
    .meta({ description: "false when the invite email could not be sent; resend it from the team screen" }),
});

export const teamListSchema = z.object({ members: z.array(teamMemberSchema) });

export type TeamMember = z.infer<typeof teamMemberSchema>;

export class TeamResponseDto {
  static member(admin: AdminRecord): TeamMember {
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      status: admin.status,
      googleLinked: admin.googleId !== null,
      advancedPermissions: admin.advancedPermissions,
      assignedProperties: admin.assignedProperties,
      lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    };
  }

  static list(admins: AdminRecord[]): z.infer<typeof teamListSchema> {
    return { members: admins.map((admin) => TeamResponseDto.member(admin)) };
  }
}
