/**
 * The bridge between the page and the chain.
 *
 * The point of this file is how little is in it. The browser builds its bid
 * with the *same* code the command line uses -- `bid()` from
 * `off-chain/src/tx/bid.ts`, the same Plutus schemas, the same parameter
 * application, the same settlement tag. Only two things differ:
 *
 *   the wallet    a CIP-30 extension instead of a seed phrase from .env
 *   the provider  /chain on our own server instead of Blockfrost directly
 *
 * That is deliberate and worth saying at a defence. A second implementation of
 * transaction building, in a second language runtime, is exactly where a datum
 * schema quietly diverges by one constructor tag -- and a divergence there does
 * not fail at build time. It fails on-chain, as "failed to parse datum", after
 * the user has paid a fee.
 */
import { Blockfrost, Lucid } from "@lucid-evolution/lucid";
import { network } from "@core/config.ts";
import { setBlueprint } from "@core/blueprint.ts";
import type { AuctionState, LotState } from "@core/state.ts";
import blueprint from "../../../on-chain/plutus.json";
import type { AuctionSummary } from "./api.ts";
import type { WalletApi } from "./wallet.ts";

// The browser has no filesystem, so the blueprint is imported as a module and
// handed to the shared code once, at startup. Vite inlines it at build time,
// which also means a stale bundle carries a stale script hash -- rebuild the
// web app after `make blueprint`, exactly as you re-run `deno task verify-lot`.
setBlueprint(blueprint as Parameters<typeof setBlueprint>[0]);

export { network };
export const isTestnet = network !== "Mainnet";

/**
 * A Lucid instance that reads through our proxy and signs with the user's wallet.
 *
 * The provider URL points at this server, not at Blockfrost. The project id
 * argument is a placeholder the proxy replaces -- see
 * `off-chain/src/indexer/chain-proxy.ts` for why the real one never reaches the
 * browser.
 */
export async function makeBrowserLucid(wallet: WalletApi) {
  const lucid = await Lucid(new Blockfrost(`${location.origin}/chain`, "proxied"), network);
  lucid.selectWallet.fromAPI(wallet);
  return lucid;
}

/**
 * Rebuild the auction's compile-time parameters from what the API reported.
 *
 * Every field here is one the API already publishes, and none of it is taken on
 * trust: `resolveAuction` re-derives the script address from these parameters
 * and refuses to continue unless it matches the address the auction is
 * actually at. So a read model that is stale, wrong, or hostile produces a
 * loud mismatch rather than a transaction sent to the wrong script.
 *
 * The token name is the tail of `unit`, which is the policy id (28 bytes, 56
 * hex characters) followed by the asset name.
 */
export function toAuctionState(a: AuctionSummary): AuctionState {
  return {
    unit: a.unit,
    policyId: a.policyId,
    tokenName: a.tokenName,
    params: {
      apSeller: a.sellerAddress,
      apCurrencySymbol: a.policyId,
      apTokenName: a.unit.slice(a.policyId.length),
      apMinBid: String(a.minBidLovelace),
      apEndTime: String(a.endTime),
    },
    address: a.address,
    // Fields the transaction builder does not read. They exist because
    // AuctionState is the CLI's on-disk record, and reusing that type is what
    // lets the browser call the CLI's bid() unchanged.
    datum: "",
    txHash: "",
    utxo: { txHash: "", outputIndex: 0 },
    network,
  };
}

/**
 * The lot as the minting policy's parameters describe it.
 *
 * Same reasoning as `toAuctionState`: nothing is trusted. `claim()` rebuilds
 * the policy from these and refuses to continue unless the policy id it derives
 * matches the one that actually minted the token -- so a read model that is
 * stale or wrong produces a loud mismatch rather than a burn aimed at the
 * wrong script.
 */
export function toLotState(a: AuctionSummary): LotState | null {
  if (!a.lot) return null;
  return {
    policyId: a.policyId,
    tokenNameHex: a.lot.tokenNameHex,
    unit: a.unit,
    seed: a.lot.seed,
    sellerPkh: a.lot.sellerPkh,
    tokenName: a.tokenName,
    // Not read when burning; present because LotState is the CLI's on-disk
    // record and reusing the type is what lets the browser call claim().
    txHash: "",
    network,
  };
}

/** Explorer links, so every claim on the page can be checked against the chain. */
const EXPLORER = network === "Mainnet"
  ? "https://cardanoscan.io"
  : `https://${network.toLowerCase()}.cardanoscan.io`;

export const txUrl = (hash: string) => `${EXPLORER}/transaction/${hash}`;
export const addressUrl = (addr: string) => `${EXPLORER}/address/${addr}`;
export const tokenUrl = (unit: string) => `${EXPLORER}/token/${unit}`;
