import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";
import { ADMIN_AUDIT_ACTIONS, type AdminAuditEntry, type AdminAuditPage } from "../types/admin.types.js";

export class AdminAuditQueryDto extends BaseDto {
  static override readonly schema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z
      .string()
      .regex(/^[a-f\d]{24}$/i, "Invalid cursor")
      .optional()
      .meta({ description: "`nextCursor` from the previous page" }),
    action: z.enum(ADMIN_AUDIT_ACTIONS).optional(),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .optional()
      .meta({ description: "only entries where this person acted or was acted on" }),
  });
}
export type AdminAuditQueryParams = z.infer<typeof AdminAuditQueryDto.schema>;

// ── responses ───────────────────────────────────────────────────────────────

const auditEntrySchema = z.object({
  id: z.string(),
  action: z.enum(ADMIN_AUDIT_ACTIONS),
  actorEmail: z.string().nullable(),
  targetId: z.string().nullable(),
  targetEmail: z.string().nullable(),
  changes: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })).nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  ip: z.string().nullable(),
  at: z.iso.datetime(),
});

export const auditPageSchema = z.object({
  items: z.array(auditEntrySchema),
  nextCursor: z.string().nullable().meta({ description: "send as `before` for older entries; null at the end" }),
});

export class AuditResponseDto {
  static page({ items, nextCursor }: AdminAuditPage): z.infer<typeof auditPageSchema> {
    return { items: items.map((entry) => AuditResponseDto.entry(entry)), nextCursor };
  }

  private static entry(entry: AdminAuditEntry): z.infer<typeof auditEntrySchema> {
    return {
      id: entry.id,
      action: entry.action,
      actorEmail: entry.actorEmail,
      targetId: entry.targetId,
      targetEmail: entry.targetEmail,
      changes: entry.changes,
      details: entry.details,
      ip: entry.ip,
      at: entry.at.toISOString(),
    };
  }
}
