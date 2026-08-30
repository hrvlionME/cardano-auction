/**
 * Open an auction: lock the lot NFT in a UTxO at the auction's script address.
 *
 * That UTxO *is* the auction. Every later transaction works by spending it:
 * `bid` spends it and recreates it with a higher bid in the datum, `payout`
 * spends it and distributes the contents. There is no other state anywhere.
 *
 * Two things make this transaction unusual, and both are worth understanding.
 *
 * First, **no script runs here.** The ledger executes a validator when you
 * *spend* from its address, never when you pay *to* it. So there is no
 * redeemer, no collateral, and no script attached -- this is an ordinary
 * payment that happens to be addressed to a script. The flip side is that
 * nothing checks the address is right: send the NFT to a wrong address and the
 * chain accepts it happily, and you discover the mistake when no validator can
 * ever unlock it. That is why the parameters are written to state and re-read,
 * never retyped.
 *
 * Second, **the address is derived, not chosen.** AuctionParams are
 * compile-time parameters, so applying them produces a different script, a
 * different hash, and therefore a different address. Every auction gets its
 * own address; nothing distinguishes two auctions except their parameters.
 */
import { Data, paymentCredentialOf } from "@lucid-evolution/lucid";
import type { Lucid } from "../lucid.ts";
import { auctionAddress } from "../blueprint.ts";
import { AuctionDatum, type AuctionParams } from "../types.ts";
import type { LotState } from "../state.ts";

/**
 * ADA parked in the opening UTxO alongside the NFT.
 *
 * Every Cardano output must hold enough ADA to pay for the space it occupies
 * on-chain ("min-ADA"); an output carrying one native token and an inline
 * datum needs roughly 1.2 ADA, and 2 leaves margin. The seller fronts this.
 *
 * It does not survive the first bid. `correctOutput` in the validator requires
 * the continuing output's lovelace to equal the bid *exactly* -- not the bid
 * plus whatever was already there -- so on the first bid this 2 ADA comes back
 * out as change to the bidder. Slightly unfair, entirely harmless, and worth a
 * sentence in the thesis as a limitation.
 */
const OPENING_LOVELACE = 2_000_000n;

/**
 * Floor on the reserve price.
 *
 * After the first bid the auction UTxO holds the NFT and exactly `bAmount`
 * lovelace. If the reserve were below min-ADA, that output would be beneath
 * the ledger's minimum and the transaction would be rejected outright -- by
 * the ledger, before the validator is even consulted, with an error that says
 * nothing about auctions. Refusing here gives a comprehensible message.
 */
const MIN_BID_FLOOR = 2_000_000n;

export interface OpenedAuction {
  /** The parameters baked into this auction's script. Needed by every later tx. */
  params: AuctionParams;
  /** Derived from those parameters. */
  address: string;
  /** The opening datum: `Nothing`, i.e. no bids yet. Hex-encoded. */
  datum: string;
  unit: string;
  txHash: string;
}

export interface OpenAuctionOptions {
  /** Reserve price in lovelace. The first bid must be >= this. */
  minBid: bigint;
  /** POSIX time in *milliseconds*, matching PlutusLedgerApi's POSIXTime. */
  endTime: bigint;
}

export async function openAuction(
  lucid: Lucid,
  lot: LotState,
  { minBid, endTime }: OpenAuctionOptions,
): Promise<OpenedAuction> {
  const address = await lucid.wallet().address();
  const walletPkh = paymentCredentialOf(address).hash;

  // The auction pays the winning bid to apSeller, and the lot policy will only
  // let apSeller co-sign the burn. If those were different keys the money and
  // the delivery receipt would end up with different people, and the auction
  // would settle into a state nobody can finish. Same key, checked here.
  if (walletPkh !== lot.sellerPkh) {
    throw new Error(
      `This wallet is not the seller of "${lot.tokenName}".\n` +
        `  lot was minted by: ${lot.sellerPkh}\n` +
        `  this wallet is:    ${walletPkh}\n` +
        `The seller key is baked into the minting policy and cannot be changed.`,
    );
  }

  if (minBid < MIN_BID_FLOOR) {
    throw new Error(
      `Reserve price ${minBid} lovelace is below the ${MIN_BID_FLOOR} floor.\n` +
        `The auction UTxO must hold the winning bid *as* its ADA, and an output\n` +
        `below min-ADA is rejected by the ledger.`,
    );
  }

  const now = BigInt(Date.now());
  if (endTime <= now) {
    throw new Error(
      `End time ${endTime} is in the past (now ${now}). Bidding would be closed ` +
        `before the auction opened.`,
    );
  }

  // The wallet must actually hold the NFT. Without this check the transaction
  // still builds -- Lucid would just fail to balance it, with a message about
  // insufficient assets rather than about the lot.
  const utxos = await lucid.wallet().getUtxos();
  const holdsLot = utxos.some((u) => (u.assets[lot.unit] ?? 0n) > 0n);
  if (!holdsLot) {
    throw new Error(
      `Wallet does not hold ${lot.tokenName} (${lot.unit}).\n` +
        `Either the mint has not confirmed yet, or this auction is already open.`,
    );
  }

  const params: AuctionParams = {
    apSeller: lot.sellerPkh,
    // The policy id *is* the minting policy's script hash, and Plutus calls
    // that the CurrencySymbol. Same 28 bytes, two names.
    apCurrencySymbol: lot.policyId,
    apTokenName: lot.tokenNameHex,
    apMinBid: minBid,
    apEndTime: endTime,
  };

  const auctionAddr = await auctionAddress(params);

  // `Nothing`: no highest bid yet. This encodes to d87a80 (Constr 1, empty),
  // which is what PlutusTx's Maybe expects for Nothing. It is what makes the
  // first bid legal -- with Nothing in the datum `sufficientBid` falls through
  // to "clears the reserve" and `refundsPreviousHighestBid` is vacuously true.
  const datum = Data.to(null, AuctionDatum);

  // Inline, not a datum hash. The validator reads the *output's* datum when
  // checking the continuing output, and inline datums keep the whole auction
  // state visible on-chain without anyone having to publish a preimage.
  const tx = await lucid
    .newTx()
    .pay.ToContract(
      auctionAddr,
      { kind: "inline", value: datum },
      { lovelace: OPENING_LOVELACE, [lot.unit]: 1n },
    )
    // No `localUPLCEval: false` here, unlike every other transaction in this
    // project: nothing is being spent from a script address, so there is no
    // script to evaluate and nothing for Lucid's stale evaluator to choke on.
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  return { params, address: auctionAddr, datum, unit: lot.unit, txHash };
}
