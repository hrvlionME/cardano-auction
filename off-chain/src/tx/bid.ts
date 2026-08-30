/**
 * Place a bid: raise the auction and refund whoever is being displaced.
 *
 * This is the transaction the whole design is built around. It spends the
 * auction UTxO and recreates it one bid higher, and in the *same* transaction
 * hands the previous leader their money back. That is why there is no
 * withdraw-my-bid endpoint anywhere in the contract: a losing bid is returned
 * the instant it is beaten, so at any moment the only locked funds belong to
 * the current leader -- who must not be allowed to withdraw anyway.
 *
 * The `NewBid` branch imposes four conditions (AuctionValidator.hs):
 *
 *   sufficientBid              beats the standing bid, or clears the reserve
 *   validBidTime               the whole validity range sits at or before apEndTime
 *   refundsPreviousHighestBid  an output returns the old leader's exact stake
 *   correctOutput              exactly one continuing output, holding the lot
 *                              and exactly this bid, with a datum naming it
 *
 * Note what the validator does *not* ask: nothing about who signed. Anyone can
 * submit a bid on anyone's behalf -- but since the bid amount has to be paid
 * into the auction UTxO, paying for someone else's bid only loses you money.
 * The ledger, not the validator, is what stops you bidding funds you lack.
 */
import { Data, paymentCredentialOf } from "@lucid-evolution/lucid";
import type { Lucid } from "../lucid.ts";
import { AuctionDatum, AuctionRedeemer, type Bid } from "../types.ts";
import type { AuctionState } from "../state.ts";
import { addressForPkh, resolveAuction } from "./auction.ts";

export interface PlacedBid {
  /** The bid now recorded in the auction's datum. */
  bid: Bid;
  /** Who was refunded, and how much. null if this was the opening bid. */
  refund: { pkh: string; address: string; amount: bigint } | null;
  /** The auction UTxO consumed, whose TxOutRef tags the refund. */
  spent: { txHash: string; outputIndex: number };
  txHash: string;
}

export async function bid(
  lucid: Lucid,
  auction: AuctionState,
  amount: bigint,
): Promise<PlacedBid> {
  const { params, script, utxo: auctionUtxo, highestBid, tag } = await resolveAuction(
    lucid,
    auction,
  );

  const bidderAddress = await lucid.wallet().address();
  const bidderPkh = paymentCredentialOf(bidderAddress).hash;

  // Check `sufficientBid` here so a losing bid costs nothing but a moment,
  // rather than a submitted transaction and a script evaluation failure.
  if (highestBid) {
    if (amount <= highestBid.bAmount) {
      throw new Error(
        `Bid must beat the standing bid.\n` +
          `  standing: ${highestBid.bAmount} lovelace (by ${highestBid.bPkh})\n` +
          `  yours:    ${amount} lovelace`,
      );
    }
  } else if (amount < params.apMinBid) {
    throw new Error(
      `Opening bid must clear the reserve.\n` +
        `  reserve: ${params.apMinBid} lovelace\n` +
        `  yours:   ${amount} lovelace`,
    );
  }

  // `validBidTime` requires the *whole* validity range to sit at or before
  // apEndTime, so the bid cannot possibly land after close. An unbounded
  // upper end -- Lucid's default -- is therefore never contained, and every
  // bid would be rejected. Hence an explicit validTo.
  //
  // Unlike payout, no slack is needed and slack would be actively wrong.
  // `validTo` floors its millisecond timestamp to a slot, and the ledger
  // reports that slot's time, which is therefore <= apEndTime already.
  // Rounding works in our favour in this direction and against us in the other.
  const now = BigInt(Date.now());
  if (now >= params.apEndTime) {
    throw new Error(
      `Bidding closed at ${new Date(Number(params.apEndTime)).toISOString()}. ` +
        `Settle it with \`deno task payout\`.`,
    );
  }

  const newBid: Bid = { bPkh: bidderPkh, bAmount: amount };

  let tx = lucid
    .newTx()
    .collectFrom([auctionUtxo], Data.to({ NewBid: [newBid] }, AuctionRedeemer))
    .attach.SpendingValidator(script)
    .validTo(Number(params.apEndTime))
    // The continuing output. `correctOutput` demands exactly one output back
    // to the auction address, holding the lot and *exactly* this bid in
    // lovelace -- not the bid plus what was already there. Whatever ADA the
    // spent UTxO held above the new bid comes back to us as change, which is
    // how the seller's opening 2 ADA finds its way to the first bidder.
    .pay.ToContract(
      auction.address,
      { kind: "inline", value: Data.to(newBid, AuctionDatum) },
      { lovelace: amount, [auction.unit]: 1n },
    );

  let refund: PlacedBid["refund"] = null;
  if (highestBid) {
    // Exactly their stake, tagged with the input we are spending. Equality
    // again, not sufficiency -- refunding too much fails as hard as too little.
    const address = await addressForPkh(lucid, highestBid.bPkh);
    refund = { pkh: highestBid.bPkh, address, amount: highestBid.bAmount };
    tx = tx.pay.ToAddressWithData(
      address,
      { kind: "inline", value: tag },
      { lovelace: highestBid.bAmount },
    );
  }

  // Evaluate on the node: Lucid's bundled evaluator predates plutus-tx 1.67
  // and dies decoding the ScriptContext before our logic ever runs.
  const completed = await tx.complete({ localUPLCEval: false });
  const signed = await completed.sign.withWallet().complete();
  const txHash = await signed.submit();

  return {
    bid: newBid,
    refund,
    spent: { txHash: auctionUtxo.txHash, outputIndex: auctionUtxo.outputIndex },
    txHash,
  };
}
