/**
 * Shared groundwork for the two transactions that spend the auction UTxO.
 *
 * `bid` and `payout` differ in what they check and what they pay out, but they
 * agree entirely on how to find the auction and what to attach: same address
 * derivation, same script, same way of reading the current state, same
 * settlement tag. Keeping that in one place means the two cannot drift apart
 * in some detail that only shows up as a failed on-chain evaluation.
 */
import {
  credentialToAddress,
  Data,
  keyHashToCredential,
  paymentCredentialOf,
  type Script,
  type UTxO,
} from "@lucid-evolution/lucid";
import type { Lucid } from "../lucid.ts";
import { auctionAddress, auctionScript } from "../blueprint.ts";
import { AuctionDatum, type AuctionParams, type Bid, settlementTag } from "../types.ts";
import { type AuctionState, deserialiseParams } from "../state.ts";
import { network } from "../config.ts";

export interface ResolvedAuction {
  params: AuctionParams;
  address: string;
  /** The parameterised validator, ready to attach. */
  script: Script;
  /** The live auction UTxO: the one at the address holding the lot. */
  utxo: UTxO;
  /** Current state, straight from the UTxO's datum. null means no bids yet. */
  highestBid: Bid | null;
  /** This input's TxOutRef, hex-encoded -- the datum every settling output needs. */
  tag: string;
}

/**
 * An address the holder of `pkh` can actually spend from.
 *
 * The validator checks addresses with `toPubKeyHash`, which reads the payment
 * credential and ignores the staking part, so any address built on this
 * payment key satisfies it. Which one we pick still matters off-chain: a
 * seed-phrase wallet watches exactly one address, its base address. Paying
 * someone at a bare enterprise address built from the same key would satisfy
 * the validator and then never appear in their wallet, looking for all the
 * world like the money vanished. So a key we hold gets its real address, and
 * anyone else gets an enterprise address -- the most that can be built knowing
 * only a payment key hash.
 */
export async function addressForPkh(lucid: Lucid, pkh: string): Promise<string> {
  const own = await lucid.wallet().address();
  if (paymentCredentialOf(own).hash === pkh) return own;
  return credentialToAddress(network, keyHashToCredential(pkh));
}

/** Locate the live auction and everything needed to spend it. */
export async function resolveAuction(
  lucid: Lucid,
  auction: AuctionState,
): Promise<ResolvedAuction> {
  const params = deserialiseParams(auction.params);

  // Rebuild the address from the parameters rather than trusting the saved
  // one. If the Haskell moved since this auction was opened, the script hash
  // moved with it, and we would be attaching a validator that does not match
  // the address holding the funds -- the node rejects that with something far
  // less informative than this.
  const address = await auctionAddress(params);
  if (address !== auction.address) {
    throw new Error(
      `Script drift: this code no longer produces the address this auction lives at.\n` +
        `  auction opened at: ${auction.address}\n` +
        `  code now derives:  ${address}\n` +
        `Rebuild the blueprint (cd ../on-chain && make blueprint), or check out ` +
        `the commit that opened this auction.`,
    );
  }

  // The lot token is unique, so "the UTxO at this address holding the lot" is
  // an unambiguous description of the live auction. Read it from the chain,
  // not from the state file, which goes stale on every bid.
  const utxos = await lucid.utxosAt(address);
  const utxo = utxos.find((u) => (u.assets[auction.unit] ?? 0n) > 0n);
  if (!utxo) {
    throw new Error(
      `No auction UTxO at ${address}: the lot is not there.\n` +
        `This auction has already been settled.`,
    );
  }
  if (!utxo.datum) {
    throw new Error(
      `Auction UTxO ${utxo.txHash}#${utxo.outputIndex} has no inline datum. ` +
        `Something other than this tool paid to the auction address.`,
    );
  }

  return {
    params,
    address,
    script: await auctionScript(params),
    utxo,
    highestBid: Data.from(utxo.datum, AuctionDatum),
    tag: settlementTag(utxo.txHash, utxo.outputIndex),
  };
}
