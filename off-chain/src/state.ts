/**
 * Reading and writing the local `state/` directory.
 *
 * Each transaction in the lifecycle leaves behind what the next one needs.
 * `mint-lot` writes a lot file; `open-auction` reads it and writes an auction
 * file; `bid`, `payout` and `claim` read that.
 *
 * This is deliberately a folder of JSON, not a database. It is a CLI demo, and
 * everything in here is *recomputable from the chain* -- the auction address
 * is derived from the parameters, and the live auction UTxO is always "the
 * UTxO at that address holding the lot NFT". The files are a convenience so
 * you do not have to retype 56-character hex strings, not a source of truth.
 */
import type { AuctionParams } from "./types.ts";

const STATE_DIR = "state";

/** What `mint-lot` saved. Mirrors MintedLot plus the human-readable extras. */
export interface LotState {
  policyId: string;
  tokenNameHex: string;
  unit: string;
  seed: { txHash: string; outputIndex: number };
  sellerPkh: string;
  txHash: string;
  tokenName: string;
  network: string;
}

/** What `open-auction` saves. */
export interface AuctionState {
  /** The lot this auction is selling. */
  unit: string;
  policyId: string;
  tokenName: string;
  /** Compile-time parameters, serialised. BigInts become strings in JSON. */
  params: {
    apSeller: string;
    apCurrencySymbol: string;
    apTokenName: string;
    apMinBid: string;
    apEndTime: string;
  };
  /** Derived from the parameters; stored so you can eyeball it. */
  address: string;
  /** The opening datum, `Nothing`, as hex. */
  datum: string;
  txHash: string;
  /** Where the auction UTxO landed. Convenience only -- see the note above. */
  utxo: { txHash: string; outputIndex: number };
  network: string;
  /** Filled in by `payout` once the auction has settled. */
  settlement?: {
    txHash: string;
    /** null when the auction closed with no bids. */
    winnerPkh: string | null;
    /** Lovelace, as a string. null when there were no bids. */
    winningBid: string | null;
    /** Where the lot ended up -- what `claim` will burn from. */
    lotAddress: string;
  };
}

async function readState<T>(prefix: string, id?: string): Promise<T> {
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(STATE_DIR)) {
      if (e.isFile && e.name.startsWith(`${prefix}-`) && e.name.endsWith(".json")) {
        names.push(e.name);
      }
    }
  } catch {
    throw new Error(`No ${STATE_DIR}/ directory yet. Run \`deno task mint-lot\` first.`);
  }

  const matches = id ? names.filter((n) => n.includes(id)) : names;
  if (matches.length === 0) {
    throw new Error(
      id
        ? `No ${STATE_DIR}/${prefix}-*.json matching "${id}". Have: ${names.join(", ") || "none"}`
        : `No ${STATE_DIR}/${prefix}-*.json files.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Several ${prefix} files match; pass an id to pick one:\n  ${matches.join("\n  ")}`,
    );
  }
  // Safe: length is exactly 1 here, but noUncheckedIndexedAccess does not know that.
  return JSON.parse(await Deno.readTextFile(`${STATE_DIR}/${matches[0]!}`)) as T;
}

/** Load the minted lot. With one lot on disk the id is optional. */
export function loadLot(policyId?: string): Promise<LotState> {
  return readState<LotState>("lot", policyId);
}

/** Load an opened auction. With one auction on disk the id is optional. */
export function loadAuction(policyId?: string): Promise<AuctionState> {
  return readState<AuctionState>("auction", policyId);
}

/** JSON cannot hold BigInt, so the Lovelace and POSIXTime fields go out as strings. */
export function serialiseParams(p: AuctionParams): AuctionState["params"] {
  return {
    apSeller: p.apSeller,
    apCurrencySymbol: p.apCurrencySymbol,
    apTokenName: p.apTokenName,
    apMinBid: p.apMinBid.toString(),
    apEndTime: p.apEndTime.toString(),
  };
}

/** The inverse. Every later transaction must rebuild the *exact* same params. */
export function deserialiseParams(p: AuctionState["params"]): AuctionParams {
  return {
    apSeller: p.apSeller,
    apCurrencySymbol: p.apCurrencySymbol,
    apTokenName: p.apTokenName,
    apMinBid: BigInt(p.apMinBid),
    apEndTime: BigInt(p.apEndTime),
  };
}

export async function saveAuction(state: AuctionState): Promise<string> {
  await Deno.mkdir(STATE_DIR, { recursive: true });
  const path = `${STATE_DIR}/auction-${state.policyId}.json`;
  await Deno.writeTextFile(path, JSON.stringify(state, null, 2));
  return path;
}
