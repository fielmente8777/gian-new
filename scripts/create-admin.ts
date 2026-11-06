// Adds a staff member to admin_users, or restores an existing one to this role and makes them active.
// This is how the first super admins exist, because nobody can sign up to the admin console.
//
//   npx tsx scripts/create-admin.ts you@eazotel.com "Your Name"
//   npx tsx scripts/create-admin.ts someone@eazotel.com "Their Name" --role admin
import { parseArgs } from "node:util";

import { z } from "zod";

import { EnvValidationError, loadConfig } from "../src/config/index.js";
import { AdminAuditLogRepository } from "../src/modules/admin/repositories/admin-audit-log.repository.js";
import { AdminUserRepository } from "../src/modules/admin/repositories/admin-user.repository.js";
import type { AdminRole } from "../src/modules/admin/types/admin.types.js";
import { Database } from "../src/shared/database/database.js";
import { LoggerFactory } from "../src/shared/logger/logger.js";

const USAGE = 'Usage: npx tsx scripts/create-admin.ts <email> ["Full Name"] [--role super_admin|admin]';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { role: { type: "string", default: "super_admin" } },
});

const email = z.email().safeParse(positionals[0]?.trim().toLowerCase());
const role = z.enum(["super_admin", "admin"]).safeParse(values.role);
if (!email.success || !role.success) {
  console.error(USAGE);
  process.exit(1);
}

try {
  const config = loadConfig();
  const database = new Database(config.database, LoggerFactory.create(config.app));
  await database.connect();
  const admins = new AdminUserRepository();
  await admins.ensureIndexes();
  const admin = await admins.upsertActive({
    email: email.data,
    name: positionals[1]?.trim() || null,
    role: role.data satisfies AdminRole,
  });
  await new AdminAuditLogRepository().create(
    {
      action: "team.saved_by_script",
      targetId: admin.id,
      targetEmail: admin.email,
      details: { role: admin.role, script: "scripts/create-admin.ts" },
    },
    new Date(),
  );
  console.log(`Saved ${admin.email} as ${admin.role} in database "${config.database.MONGO_DB}".`);
  await database.disconnect();
} catch (error) {
  console.error(error instanceof EnvValidationError ? error.message : error);
  process.exit(1);
}
