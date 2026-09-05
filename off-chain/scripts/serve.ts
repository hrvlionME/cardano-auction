/**
 * Serve the indexer's data over HTTP.
 *
 *   deno task serve              # port 8000, serves whatever is already synced
 *   deno task serve --sync       # also keep syncing from the chain while serving
 *   deno task serve --port 9000
 *
 * Read-only. The server holds no keys and signs nothing; see src/indexer/api.ts.
 * Bidding happens through a wallet, which is what `deno task bid` demonstrates.
 */
import { openDb } from "../src/indexer/db.ts";
import { handle } from "../src/indexer/api.ts";
import { syncAll } from "../src/indexer/sync.ts";
import { network } from "../src/config.ts";
import { friendlyErrors } from "../src/cli.ts";

friendlyErrors();

const args = [...Deno.args];
const portAt = args.indexOf("--port");
const port = portAt === -1 ? 8000 : Number(args[portAt + 1]);
const keepSyncing = args.includes("--sync");
const SYNC_INTERVAL_MS = 20_000;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${args[portAt + 1]}`);
  Deno.exit(1);
}

const db = await openDb();

if (keepSyncing) {
  // Deliberately not awaited: the server should start answering immediately,
  // serving whatever has already been indexed, rather than waiting on the
  // chain. A read model is allowed to be behind; that is what makes it a read
  // model rather than an authority.
  (async () => {
    while (true) {
      try {
        const { events } = await syncAll(db);
        if (events > 0) console.log(`  synced ${events} new event(s)`);
      } catch (e) {
        console.error(`  sync failed (will retry): ${e instanceof Error ? e.message : e}`);
      }
      await new Promise((r) => setTimeout(r, SYNC_INTERVAL_MS));
    }
  })();
}

console.log(`\nnetwork:  ${network}`);
console.log(`syncing:  ${keepSyncing ? `every ${SYNC_INTERVAL_MS / 1000}s` : "no (run `deno task sync`)"}`);
console.log(`\nlistening on http://localhost:${port}\n`);
console.log(`  curl -s localhost:${port}/health | jq`);
console.log(`  curl -s localhost:${port}/auctions | jq`);
console.log(`  curl -s localhost:${port}/auctions/<policyId> | jq\n`);

Deno.serve({ port, onListen: () => {} }, (req) => handle(db, req));
