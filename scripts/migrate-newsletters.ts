// Tidies nexon's `Newsletters` rows so the newsletter module can keep one row per address:
//   - email trimmed and lower-cased
//   - rows of the same client and address merged into the oldest one (tags joined; if any copy
//     is unsubscribed, the kept row is too, so nobody who opted out is emailed again)
//   - rows without a client (ndid) or an email reported, never deleted
// Then builds the unique { ndid, email } index. Shows what would change and writes nothing
// unless --apply. Safe to run again.
//
//   npx tsx scripts/migrate-newsletters.ts            # dry run
//   npx tsx scripts/migrate-newsletters.ts --apply    # writes
//
// Point MONGO_URI at a copy of the database first if you only want to try it.
import { parseArgs } from "node:util";

import mongoose, { type Types } from "mongoose";

import { EnvValidationError, loadConfig } from "../src/config/index.js";
import { SubscriberRepository } from "../src/modules/newsletter/repositories/subscriber.repository.js";
import { Database } from "../src/shared/database/database.js";
import { LoggerFactory } from "../src/shared/logger/logger.js";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });

interface Row {
  _id: Types.ObjectId;
  ndid?: string | null;
  email?: string | null;
  status?: string;
  tags?: string[];
  unsubscribedAt?: Date | null;
  unsubscribedBy?: string | null;
  unsubscribeReason?: string | null;
}

try {
  const config = loadConfig();
  const database = new Database(config.database, LoggerFactory.create(config.app));
  await database.connect();
  console.log(`Database "${config.database.MONGO_DB}" · ${values.apply ? "APPLYING" : "dry run (add --apply to write)"}\n`);

  const collection = mongoose.connection.collection<Row>("Newsletters");
  const rows = await collection.find({}).sort({ _id: 1 }).toArray();
  const orphans = rows.filter((r) => !r.ndid || !r.email?.trim());
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    if (!row.ndid || !row.email?.trim()) continue;
    const key = `${row.ndid}\u0000${row.email.trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  let renamed = 0;
  let merged = 0;
  for (const [key, group] of groups) {
    const email = key.split("\u0000")[1]!;
    const [keep, ...extra] = group; // oldest first
    const out = group.find((r) => r.status === "unsubscribed");
    const tags = [...new Set(group.flatMap((r) => r.tags ?? []))];
    const set: Record<string, unknown> = {};
    if (keep!.email !== email) set.email = email;
    if (extra.length && tags.length) set.tags = tags;
    if (out && keep!.status !== "unsubscribed") {
      Object.assign(set, {
        status: "unsubscribed",
        unsubscribedAt: out.unsubscribedAt ?? null,
        unsubscribedBy: out.unsubscribedBy ?? "subscriber",
        unsubscribeReason: out.unsubscribeReason ?? null,
      });
    }
    if (set.email) renamed += 1;
    merged += extra.length;
    if (extra.length) console.log(`merge ${group.length} rows of ${email} (client ${keep!.ndid})`);
    if (!values.apply) continue;
    // remove the copies first, so the lower-cased email never clashes with one of them
    if (extra.length) await collection.deleteMany({ _id: { $in: extra.map((r) => r._id) } });
    if (Object.keys(set).length) await collection.updateOne({ _id: keep!._id }, { $set: set });
  }

  console.log(`\n${rows.length} rows · ${groups.size} addresses · ${renamed} lower-cased · ${merged} duplicate rows merged`);
  if (orphans.length) {
    console.log(`${orphans.length} rows without a client or an email (left as they are):`);
    for (const r of orphans.slice(0, 20)) console.log(`  ${String(r._id)}  ndid=${r.ndid ?? "-"}  email=${r.email ?? "-"}`);
  }

  if (values.apply) {
    const warning = await new SubscriberRepository().ensureIndexes();
    console.log(warning ? `\nIndex NOT built: ${warning}` : "\nUnique { ndid, email } index built.");
  }
  console.log(values.apply ? "\nDone." : "\nNothing written. Run again with --apply to save.");
  await database.disconnect();
} catch (error) {
  console.error(error instanceof EnvValidationError ? error.message : error);
  process.exit(1);
}
