/**
 * Serve the indexer's data, a chain proxy, and (if built) the web app.
 *
 *   deno task serve              # port 8000, serves whatever is already synced
 *   deno task serve --sync       # also keep syncing from the chain while serving
 *   deno task serve --port 9000
 *
 * Three things live here, and the distinction between them matters:
 *
 *   /health, /auctions…   the read model. Read-only; see src/indexer/api.ts.
 *   /auth/…, /me/…        accounts: sign-in by wallet signature, profile and
 *                         verifiable history. These write, but only to the
 *                         application's own tables -- see src/app/api.ts.
 *   /chain/…              a Blockfrost pass-through, so the browser never sees
 *                         the project id. Relays signed transactions; cannot
 *                         sign. See src/indexer/chain-proxy.ts.
 *   everything else       the built web app from web/dist, when it exists.
 *
 * None of them holds a private key. Bidding is signed in the user's wallet,
 * whether that wallet is `deno task bid` on the command line or Eternl in a
 * browser tab.
 */
import { openDb } from "../src/indexer/db.ts";
import { handle } from "../src/indexer/api.ts";
import { APP_PATHS, handleApp } from "../src/app/api.ts";
import { ensureAppSchema } from "../src/app/db.ts";
import { CHAIN_PREFIX, proxyChain } from "../src/indexer/chain-proxy.ts";
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

/** Paths the API owns. Anything else may fall through to the web app. */
const API_PATHS = ["/health", "/auctions"];
const WEB_ROOT = new URL("../web/dist/", import.meta.url);

async function webFile(pathname: string, method = "GET"): Promise<Response | undefined> {
  // Only ever answer navigations. The index.html fallback below is right for a
  // browser asking for a client-side route and wrong for everything else: a
  // POST to an API path this server does not know would otherwise come back as
  // 200 text/html, which fails much later and somewhere unrelated when
  // something tries to read it as JSON. Exactly that happened when the web app
  // was pointed at a server predating the /auth routes.
  if (method !== "GET" && method !== "HEAD") return undefined;

  // A single-page app: unknown paths are routes the client renders, not 404s,
  // so anything without a file extension falls back to index.html.
  const rel = pathname === "/" || !pathname.includes(".") ? "index.html" : pathname.slice(1);
  try {
    const file = await Deno.readFile(new URL(rel, WEB_ROOT));
    const ext = rel.slice(rel.lastIndexOf("."));
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".png": "image/png",
      ".woff2": "font/woff2",
      // Must be exact: browsers instantiate WebAssembly by streaming, and
      // WebAssembly.instantiateStreaming refuses any other content type. Lucid
      // ships three .wasm files, so getting this wrong breaks every signature.
      ".wasm": "application/wasm",
      ".map": "application/json; charset=utf-8",
    };
    return new Response(file, {
      headers: { "content-type": types[ext] ?? "application/octet-stream" },
    });
  } catch {
    return undefined;
  }
}

const webBuilt = (await webFile("/")) !== undefined;

const db = await openDb();
await ensureAppSchema(db);

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
console.log(`web app:  ${webBuilt ? "yes, from web/dist" : "not built (cd web && npm run build)"}`);
console.log(`\nlistening on http://localhost:${port}\n`);
console.log(`  curl -s localhost:${port}/health | jq`);
console.log(`  curl -s localhost:${port}/auctions | jq`);
if (webBuilt) console.log(`  open  http://localhost:${port}/`);
console.log();

Deno.serve({ port, onListen: () => {} }, async (req) => {
  const { pathname } = new URL(req.url);
  if (pathname.startsWith(CHAIN_PREFIX)) return await proxyChain(req);
  // Before the read model, which answers 405 to anything that is not a GET.
  if (APP_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return await handleApp(db, req);
  }
  if (API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return await handle(db, req);
  }
  const file = await webFile(pathname, req.method);
  if (file) return file;
  return await handle(db, req);
});
