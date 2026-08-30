/**
 * Settle a finished auction: pay the seller, deliver the lot to the winner.
 *
 * This is the first transaction in the project that *spends* from a script
 * address, which means it is the first one where the validator actually runs.
 * Everything before it was an ordinary payment.
 *
 * The `Payout` branch imposes three conditions (AuctionValidator.hs):
 *
 *   validPayoutTime         the whole tx validity range sits at or after apEndTime
 *   sellerGetsHighestBid    an output pays apSeller exactly the winning bid
 *   highestBidderGetsAsset  an output delivers the lot to the winner
 *
 * With no bids the second is vacuously true and the "winner" is the seller, so
 * an unbid auction settles by handing the lot straight back. That is the
 * simplest possible run of this validator, and the one worth testing first.
 *
 * Both payout outputs must carry the *spent auction UTxO's* TxOutRef as an
 * inline datum. That is the double-satisfaction defence: without the tag the
 * validator will not credit the output and rejects an otherwise honest
 * transaction. See `settlementTag` and the comment on `settlesThisAuction`.
 */
import { Data } from "@lucid-evolution/lucid";
import { chainTipSlot, type Lucid } from "../lucid.ts";
import { AuctionRedeemer } from "../types.ts";
import { type AuctionState, deserialiseParams } from "../state.ts";
import type { AuctionParams } from "../types.ts";
import { addressForPkh, resolveAuction } from "./auction.ts";

/**
 * ADA attached to the output delivering the lot.
 *
 * `highestBidderGetsAsset` places no constraint on this output's lovelace --
 * only that it holds the lot and carries the tag -- but the ledger still
 * demands min-ADA for an output holding a token. When there are bids, the
 * auction UTxO's entire ADA balance is owed to the seller down to the
 * lovelace, so this comes out of the *submitter's* pocket. Nobody is paid to
 * submit `Payout`, so the submitter is out of pocket for settling someone
 * else's auction: one of the open design questions in the thesis.
 *
 * With no bids the auction UTxO's own 2 ADA covers it exactly.
 */
const LOT_DELIVERY_LOVELACE = 2_000_000n;

/**
 * Slack added to the validity range's lower bound. One second, and the reason
 * is exact rather than superstitious.
 *
 * `validFrom` takes a POSIX time in milliseconds and converts it to a slot by
 * flooring; the ledger converts that slot back to the POSIX time it reports in
 * `txInfoValidRange`. On a chain with 1-second slots the round trip therefore
 * loses up to 999 ms. `apEndTime` is very unlikely to fall on a whole second,
 * so `validFrom(apEndTime)` yields a lower bound *below* apEndTime, `from
 * apEndTime` does not contain it, and `validPayoutTime` fails -- for a
 * transaction that is, by the clock, perfectly legal.
 *
 * Flooring loses strictly less than one slot, so `apEndTime + 1000 ms` always
 * floors to a slot at or after `apEndTime`.
 */
const SLOT_SLACK_MS = 1000n;

/**
 * The lower validity bound a payout must carry: the deadline plus one slot of
 * slack. Exported so a caller can work out which slot to wait for before it
 * even builds the transaction.
 */
export function payoutValidFrom(params: AuctionParams): bigint {
  return params.apEndTime + SLOT_SLACK_MS;
}

export interface Settlement {
  /** Winner's pubkey hash, or null if the auction closed with no bids. */
  winnerPkh: string | null;
  /** Winning bid in lovelace, or null if there were none. */
  winningBid: bigint | null;
  /** Where the winning bid went. Absent when there was no bid to pay. */
  sellerAddress: string | null;
  /** Where the lot went. Equals the seller's address when nobody bid. */
  lotAddress: string;
  /** The auction UTxO consumed, whose TxOutRef tags both outputs. */
  spent: { txHash: string; outputIndex: number };
  txHash: string;
}

export async function payout(lucid: Lucid, auction: AuctionState): Promise<Settlement> {
  const { params, script, utxo: auctionUtxo, highestBid, tag } = await resolveAuction(
    lucid,
    auction,
  );

  // Guard against the *chain tip*, not the local clock. A node rejects a
  // transaction whose lower validity bound is ahead of its tip, and the tip
  // trails wall-clock time by however long it has been since the last block.
  const validFrom = payoutValidFrom(params);
  const validFromSlot = lucid.unixTimeToSlot(Number(validFrom));
  const tip = await chainTipSlot();
  if (tip < validFromSlot) {
    throw new Error(
      `Not yet settleable by the chain.\n` +
        `  auction closed at: ${new Date(Number(params.apEndTime)).toISOString()}\n` +
        `  needs chain tip:   slot ${validFromSlot}\n` +
        `  chain tip is:      slot ${tip} (${validFromSlot - tip} behind)\n` +
        `The deadline may already have passed by the clock; the chain has not ` +
        `caught up to it yet.`,
    );
  }

  const winnerPkh = highestBid ? highestBid.bPkh : null;
  const lotRecipient = winnerPkh ?? params.apSeller;
  const lotAddress = await addressForPkh(lucid, lotRecipient);

  let tx = lucid
    .newTx()
    .collectFrom([auctionUtxo], Data.to("Payout", AuctionRedeemer))
    .attach.SpendingValidator(script)
    // Lower bound only. `from apEndTime` is the half-open interval
    // [apEndTime, +inf), so an unbounded upper end is contained by it and no
    // `validTo` is needed. Contrast `bid`, which needs the opposite bound.
    .validFrom(Number(validFrom));

  let sellerAddress: string | null = null;
  if (highestBid) {
    // Exactly bAmount lovelace, no more: `sellerGetsHighestBid` tests equality,
    // not sufficiency. Overpaying the seller fails just as hard as underpaying.
    sellerAddress = await addressForPkh(lucid, params.apSeller);
    tx = tx.pay.ToAddressWithData(
      sellerAddress,
      { kind: "inline", value: tag },
      { lovelace: highestBid.bAmount },
    );
  }

  tx = tx.pay.ToAddressWithData(
    lotAddress,
    { kind: "inline", value: tag },
    { lovelace: LOT_DELIVERY_LOVELACE, [auction.unit]: 1n },
  );

  // Evaluate on the node: Lucid's bundled evaluator predates plutus-tx 1.67
  // and dies decoding the ScriptContext before our logic ever runs.
  const completed = await tx.complete({ localUPLCEval: false });
  const signed = await completed.sign.withWallet().complete();
  const txHash = await signed.submit();

  return {
    winnerPkh,
    winningBid: highestBid ? highestBid.bAmount : null,
    sellerAddress,
    lotAddress,
    spent: { txHash: auctionUtxo.txHash, outputIndex: auctionUtxo.outputIndex },
    txHash,
  };
}
