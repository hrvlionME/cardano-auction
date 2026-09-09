/**
 * Environment and network configuration.
 *
 * This module is imported by both halves of the project: the Deno CLI, where
 * configuration comes from `.env`, and the browser bundle, where Vite inlines
 * `VITE_`-prefixed variables at build time. Neither environment has the other's
 * globals, so nothing here may touch `Deno` or `import.meta.env` at module
 * scope without a guard -- a bare `Deno.env.get` at the top level is a runtime
 * crash the moment Vite loads this file.
 */
import "@std/dotenv/load";

export type Network = "Preview" | "Preprod" | "Mainnet";

/**
 * Read a variable from whichever environment we are running in.
 *
 * The browser sees `VITE_CARDANO_NETWORK`; the CLI sees `CARDANO_NETWORK`. Vite
 * only exposes prefixed variables to client code, deliberately, so that a stray
 * secret in `.env` cannot be bundled into a public page.
 */
function envVar(name: string): string | undefined {
  if (typeof Deno !== "undefined" && Deno.env) return Deno.env.get(name);
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  return meta.env?.[`VITE_${name}`];
}

function required(name: string): string {
  const v = envVar(name);
  if (!v) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

export const network = (envVar("CARDANO_NETWORK") ?? "Preview") as Network;

/** Read lazily: the smoke test runs without any of these being set. */
export const blockfrostProjectId = () => required("BLOCKFROST_PROJECT_ID");
export const walletSeedPhrase = () => required("WALLET_SEED_PHRASE");

/**
 * Bidder wallets: BIDDER1_SEED_PHRASE, BIDDER2_SEED_PHRASE, and so on.
 *
 * All optional, because nothing in the contracts forbids the seller bidding on
 * their own auction -- the whole lifecycle runs on one wallet. It demonstrates
 * much less, though. With one key you never see a refund leave for someone
 * else, and the burn's two-party handshake collapses into a single signature.
 * With two bidders you get the case that actually exercises the design: one
 * bidder displacing another, and the displaced stake having to find its way
 * back to a stranger the contract knows only by public key hash.
 */
export const bidderSeedPhrase = (n: number) => required(`BIDDER${n}_SEED_PHRASE`);

/** Which bidder wallets are actually configured, in order. */
export function bidderIndices(): number[] {
  const found: number[] = [];
  for (let n = 1; n <= 9; n++) {
    if (envVar(`BIDDER${n}_SEED_PHRASE`)) found.push(n);
  }
  return found;
}

export const hasBidderWallet = () => bidderIndices().length > 0;

/**
 * Where to read the chain from, and with what headers.
 *
 * The CLI talks to Blockfrost directly with a project id from `.env`. The
 * browser must not: a project id shipped to a browser is a project id
 * published. It goes through this server's `/chain` proxy instead, which adds
 * the header out of sight -- see src/indexer/chain-proxy.ts.
 *
 * Shared code that reads the chain outside Lucid's provider (the chain tip, an
 * asset's supply) has to go through here, or it works on the command line and
 * throws "Missing BLOCKFROST_PROJECT_ID" in a browser.
 */
export function chainApiBase(): { url: string; headers: Record<string, string> } {
  if (typeof Deno === "undefined") {
    return { url: `${globalThis.location.origin}/chain`, headers: {} };
  }
  return { url: blockfrostUrl(), headers: { project_id: blockfrostProjectId() } };
}

export function blockfrostUrl(n: Network = network): string {
  switch (n) {
    case "Preview":
      return "https://cardano-preview.blockfrost.io/api/v0";
    case "Preprod":
      return "https://cardano-preprod.blockfrost.io/api/v0";
    case "Mainnet":
      return "https://cardano-mainnet.blockfrost.io/api/v0";
  }
}

/**
 * The indexer's MariaDB connection.
 *
 * Read lazily, like the Blockfrost key: the smoke test and every transaction
 * builder run without a database, because the database is not on the path that
 * moves money. Only the indexer and the read API need it.
 */
export function dbConfig() {
  return {
    host: envVar("DB_HOST") ?? "127.0.0.1",
    port: Number(envVar("DB_PORT") ?? 3306),
    user: envVar("DB_USER") ?? "auction",
    password: envVar("DB_PASSWORD") ?? "",
    database: envVar("DB_NAME") ?? "auction_indexer",
  };
}
