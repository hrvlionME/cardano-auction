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
