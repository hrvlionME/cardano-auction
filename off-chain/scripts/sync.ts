/**
 * Replay every known auction's history from the chain into MariaDB.
 *
 *   deno task sync            # sync once and print what each auction looks like
 *   deno task sync --watch    # keep syncing every 20 seconds
 *
 * Safe to run at any time and safe to interrupt: every event is keyed by
 * (auction, transaction), so re-running inserts only what is genuinely new.
 * The database holds nothing authoritative -- `deno task db:reset` drops every
 * table and this rebuilds it from the chain.
 */
import { closeDb, openDb } from "../src/indexer/db.ts";
import { highestBid, listAuctions, listEvents } from "../src/indexer/db.ts";
import { syncAll } from "../src/indexer/sync.ts";
import { network } from "../src/config.ts";
import { friendlyErrors } from "../src/cli.ts";

friendlyErrors();

const watch = Deno.args.includes("--watch");
const INTERVAL_MS = 20_000;
const ada = (n: number) => `${(n / 1_000_000).toFixed(6)} ADA`;

const db = await openDb();

async function once(): Promise<void> {
  console.log(`\nsyncing (${network})`);
  const { auctions, events } = await syncAll(db);
  console.log(`${auctions} auction(s), ${events} new event(s)\n`);

  for (const a of await listAuctions(db)) {
    const events = await listEvents(db, a.policyId);
    const lead = await highestBid(db, a.policyId);
    const closed = Date.now() > a.endTime;

    console.log(`${a.tokenName}  [${a.status}${closed ? ", closed" : ", open"}]`);
    console.log(`  address   ${a.address}`);
    console.log(`  reserve   ${ada(a.minBid)}   ends ${new Date(a.endTime).toISOString()}`);
    console.log(
      lead
        ? `  leader    ${lead.bidderAddress?.slice(0, 24)}… at ${ada(lead.amount ?? 0)}`
        : `  leader    nobody bid`,
    );
    for (const e of events) {
      const who = e.bidderAddress ? `${e.bidderAddress.slice(0, 20)}…` : "-";
      const amt = e.amount === null ? "" : ada(e.amount);
      console.log(
        `    ${new Date(e.blockTime * 1000).toISOString().slice(11, 19)} ` +
          `${e.kind.padEnd(7)} ${amt.padStart(14)}  ${who}  ${e.txHash.slice(0, 12)}…`,
      );
    }
    console.log();
  }
}

await once();
if (!watch) await closeDb(db);
if (watch) {
  console.log(`watching; syncing every ${INTERVAL_MS / 1000}s. Ctrl-C to stop.`);
  while (true) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    await once();
  }
}
