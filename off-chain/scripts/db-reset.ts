/**
 * Destroy the indexer's database and rebuild it from the chain.
 *
 *   deno task db:reset          # drop every table, recreate, re-sync
 *   deno task db:reset --empty  # drop and recreate, but do not sync
 *
 * This command exists to be run in front of an audience. The indexer stores
 * nothing that cannot be recovered from the ledger, so throwing all of it away
 * and watching it come back is the shortest proof that the database is a
 * derived cache rather than a system of record. A conventional auction site
 * cannot survive the same demonstration: drop its tables and the bids are gone,
 * because the bids only ever existed there.
 */
import { closeDb, dropAll, openDb } from "../src/indexer/db.ts";
import { listAuctions, listEvents } from "../src/indexer/db.ts";
import { syncAll } from "../src/indexer/sync.ts";
import { dbConfig, network } from "../src/config.ts";
import { friendlyErrors } from "../src/cli.ts";

friendlyErrors();

const empty = Deno.args.includes("--empty");
const cfg = dbConfig();

const db = await openDb();

const before = await listAuctions(db);
let beforeEvents = 0;
for (const a of before) beforeEvents += (await listEvents(db, a.policyId)).length;

console.log(`\ndatabase: ${cfg.database} on ${cfg.host}:${cfg.port}`);
console.log(`dropping: ${before.length} auction(s), ${beforeEvents} event(s)`);

await dropAll(db);
await closeDb(db);

// Reopening recreates the schema: openDb runs CREATE TABLE IF NOT EXISTS.
const fresh = await openDb();
console.log("tables recreated, empty");

if (empty) {
  console.log("\n--empty given; not syncing. Run `deno task sync` to rebuild.\n");
  await closeDb(fresh);
  Deno.exit(0);
}

console.log(`\nrebuilding from the chain (${network})`);
const { auctions, events } = await syncAll(fresh);

const after = await listAuctions(fresh);
let afterEvents = 0;
for (const a of after) afterEvents += (await listEvents(fresh, a.policyId)).length;

console.log(`\nrebuilt: ${auctions} auction(s), ${afterEvents} event(s) (${events} inserted)`);
if (before.length > 0) {
  const same = after.length === before.length && afterEvents === beforeEvents;
  console.log(
    same
      ? "identical to what was dropped -- the chain held all of it"
      : `differs from what was dropped (was ${before.length}/${beforeEvents}); ` +
        "expected only if an auction changed on-chain in between",
  );
}
console.log();

await closeDb(fresh);
