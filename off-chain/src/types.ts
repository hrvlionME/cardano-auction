/**
 * Plutus data schemas mirroring the on-chain Haskell types.
 *
 * Every schema here must match its Haskell counterpart byte for byte. A
 * mismatch does not fail loudly at build time -- it fails on-chain, as an
 * opaque "failed to parse datum" long after you submitted. Cross-check against
 * ../../on-chain/src/ when changing anything.
 *
 * Constructor tags: PlutusTx encodes `Constr i` as CBOR tag 121 + i, so
 * constructor 0 is tag 121 (hex d879) and constructor 1 is tag 122 (d87a).
 */
import { Data } from "@lucid-evolution/lucid";

/**
 * Haskell: data Bid = Bid { bPkh :: PubKeyHash, bAmount :: Lovelace }
 * makeIsDataSchemaIndexed [('Bid, 0)] => Constr 0 [bytes, int]
 */
export const BidSchema = Data.Object({
  bPkh: Data.Bytes(),
  bAmount: Data.Integer(),
});
export type Bid = Data.Static<typeof BidSchema>;
export const Bid = BidSchema as unknown as Bid;

/**
 * Haskell: newtype AuctionDatum = AuctionDatum { adHighestBid :: Maybe Bid }
 *
 * Note the `deriving newtype (ToData, FromData, UnsafeFromData)`: the newtype
 * wrapper is *transparent*, so this encodes as a bare `Maybe Bid` with no
 * extra constructor layer. PlutusTx encodes `Just x` as Constr 0 [x] and
 * `Nothing` as Constr 1 [], which is exactly Data.Nullable.
 */
export const AuctionDatumSchema = Data.Nullable(BidSchema);
export type AuctionDatum = Data.Static<typeof AuctionDatumSchema>;
export const AuctionDatum = AuctionDatumSchema as unknown as AuctionDatum;

/**
 * Haskell: data AuctionRedeemer = NewBid Bid | Payout
 * makeIsDataSchemaIndexed [('NewBid, 0), ('Payout, 1)]
 */
export const AuctionRedeemerSchema = Data.Enum([
  Data.Object({ NewBid: Data.Tuple([BidSchema]) }),
  Data.Literal("Payout"),
]);
export type AuctionRedeemer = Data.Static<typeof AuctionRedeemerSchema>;
export const AuctionRedeemer = AuctionRedeemerSchema as unknown as AuctionRedeemer;

/**
 * Haskell: PlutusLedgerApi.V3.TxOutRef
 *
 * TxId derives ToData *newtype-style*, so the transaction id is plain bytes
 * with no constructor wrapper. TxOutRef itself is Constr 0 [txId, index].
 *
 * This is the tag attached to refund and payout outputs to defeat double
 * satisfaction -- see settlesThisAuction in AuctionValidator.hs.
 */
export const TxOutRefSchema = Data.Object({
  txOutRefId: Data.Bytes(),
  txOutRefIdx: Data.Integer(),
});
export type TxOutRef = Data.Static<typeof TxOutRefSchema>;
export const TxOutRef = TxOutRefSchema as unknown as TxOutRef;

/**
 * Haskell: data AuctionParams -- compile-time parameters.
 * Applied to the script before use; changing any field changes the script
 * hash and therefore the auction's address.
 */
export const AuctionParamsSchema = Data.Object({
  apSeller: Data.Bytes(),
  apCurrencySymbol: Data.Bytes(),
  apTokenName: Data.Bytes(),
  apMinBid: Data.Integer(),
  apEndTime: Data.Integer(),
});
export type AuctionParams = Data.Static<typeof AuctionParamsSchema>;
export const AuctionParams = AuctionParamsSchema as unknown as AuctionParams;

/**
 * Haskell: data LotParams -- compile-time parameters of the minting policy.
 * lpSeedRef is the UTxO whose consumption makes the mint unrepeatable.
 */
export const LotParamsSchema = Data.Object({
  lpSeedRef: TxOutRefSchema,
  lpTokenName: Data.Bytes(),
  lpSeller: Data.Bytes(),
});
export type LotParams = Data.Static<typeof LotParamsSchema>;
export const LotParams = LotParamsSchema as unknown as LotParams;

/** Helper: build the datum tag that marks an output as settling one auction input. */
export function settlementTag(txHash: string, outputIndex: number): string {
  return Data.to({ txOutRefId: txHash, txOutRefIdx: BigInt(outputIndex) }, TxOutRef);
}
