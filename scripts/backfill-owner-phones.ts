// Gives every hotel account holder with no phone the hotel's own phone, so they appear with a
// number in the dashboard's Team management and can be picked for WhatsApp lead alerts.
//
// Why: nexon's Google sign-up writes no phone on the owner's Zucks_users row, and the email
// sign-up from the website sends none either; onboarding only saved the hotel phone on
// Zucks_profile. gian's onboarding now fills it for new clients; this fixes the old ones.
//
//   npx tsx scripts/backfill-owner-phones.ts            # dry run: lists what it would change
//   npx tsx scripts/backfill-owner-phones.ts --apply    # writes
//
// Safe to run again. Same rules as the admin console's "Missing numbers" screen (OwnerPhoneFiller):
// - a phone that is already stored is never replaced (the write itself requires it to be empty);
// - only the account holder (oldest admin of the ndid) is filled, never a team member;
// - hotel phones without a country code are listed for a person to fix, never guessed;
// - the number is added to every lead source's WhatsApp list of each property, skipping lists
//   that already have it in any format; alert switches and emails are never changed.
// Each fix is written to the admin audit log (client.owner_phone_filled).
// Point MONGO_URI at a copy of the database to try it first.
import { parseArgs } from "node:util";

import { EnvValidationError, loadConfig } from "../src/config/index.js";
import { AdminAuditLogRepository } from "../src/modules/admin/repositories/admin-audit-log.repository.js";
import { OwnerPhoneFiller } from "../src/modules/admin/services/admin-team-phones.service.js";
import { HotelNotificationsModule } from "../src/modules/hotel-notifications/index.js";
import { ProfilesModule } from "../src/modules/profiles/index.js";
import { UsersModule } from "../src/modules/users/index.js";
import { Database } from "../src/shared/database/database.js";
import { LoggerFactory } from "../src/shared/logger/logger.js";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
const SCRIPT = "scripts/backfill-owner-phones.ts";

try {
  const config = loadConfig();
  const database = new Database(config.database, LoggerFactory.create(config.app));
  await database.connect();
  console.log(
    `Database "${config.database.MONGO_DB}" · ${values.apply ? "APPLYING" : "dry run (add --apply to write)"}\n`,
  );

  const users = new UsersModule().port;
  const profiles = new ProfilesModule().port;
  const filler = new OwnerPhoneFiller(profiles, users, new HotelNotificationsModule().port);
  const audit = new AdminAuditLogRepository();

  const owners = await users.ownersWithoutPhone(5000);
  const counts = { fix: 0, manual: 0, noProfile: 0, fixed: 0, skipped: 0 };
  const manual: string[] = [];

  for (const owner of owners) {
    const ndid = owner.ndid!;
    const profile = await profiles.findByNdid(ndid);
    if (!profile) {
      // signed up but never onboarded: there is no hotel phone to copy
      counts.noProfile++;
      continue;
    }
    const phone = OwnerPhoneFiller.suggestion(profile.hotelPhone);
    if (!phone) {
      counts.manual++;
      manual.push(`  ${ndid}  ${profile.hotelName ?? "-"}  ${owner.email}  hotel phone: ${profile.hotelPhone ?? "none"}`);
      continue;
    }
    counts.fix++;
    if (!values.apply) {
      console.log(`would fix  ${ndid}  ${profile.hotelName ?? "-"}  ${owner.email}  →  ${phone}`);
      continue;
    }

    const result = await filler.fill(ndid);
    if (result.outcome !== "fixed") {
      counts.skipped++;
      console.log(`skipped    ${ndid}  ${result.outcome}`);
      continue;
    }
    counts.fixed++;
    console.log(`fixed      ${ndid}  ${profile.hotelName ?? "-"}  ${owner.email}  →  ${phone}  (+${result.alertsAdded} alert lists)`);
    await audit.create(
      {
        action: "client.owner_phone_filled",
        actorEmail: SCRIPT,
        targetId: ndid,
        targetEmail: owner.email,
        changes: { phone: { from: null, to: phone } },
        details: { hotelName: profile.hotelName, alertListsAdded: result.alertsAdded, from: "hotel phone", script: SCRIPT },
      },
      new Date(),
    );
  }

  if (manual.length) {
    console.log(`\nNeed a person (hotel phone missing or without a country code). Fix these from the admin console:`);
    console.log(manual.join("\n"));
  }
  console.log(
    `\nOwners without a phone: ${owners.length} · ` +
      (values.apply ? `fixed ${counts.fixed}, skipped ${counts.skipped}` : `would fix ${counts.fix}`) +
      ` · need a person ${counts.manual} · never onboarded ${counts.noProfile}`,
  );
  console.log(values.apply ? "Done." : "Nothing written. Run again with --apply to save.");
  await database.disconnect();
} catch (error) {
  console.error(error instanceof EnvValidationError ? error.message : error);
  process.exit(1);
}
