/** Environment and network configuration. */
import "@std/dotenv/load";

export type Network = "Preview" | "Preprod" | "Mainnet";

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

export const network = (Deno.env.get("CARDANO_NETWORK") ?? "Preview") as Network;

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
    if (Deno.env.get(`BIDDER${n}_SEED_PHRASE`)) found.push(n);
  }
  return found;
}

export const hasBidderWallet = () => bidderIndices().length > 0;

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
    host: Deno.env.get("DB_HOST") ?? "127.0.0.1",
    port: Number(Deno.env.get("DB_PORT") ?? 3306),
    user: Deno.env.get("DB_USER") ?? "auction",
    password: Deno.env.get("DB_PASSWORD") ?? "",
    database: Deno.env.get("DB_NAME") ?? "auction_indexer",
  };
}
