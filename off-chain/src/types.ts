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
import { credentialToAddress, Data, getAddressDetails } from "@lucid-evolution/lucid";
import { network } from "./config.ts";

/**
 * Haskell: PlutusLedgerApi.V1.Credential
 * Constr 0 [PubKeyHash] for a key, Constr 1 [ScriptHash] for a script.
 */
export const CredentialSchema = Data.Enum([
  Data.Object({ PubKeyCredential: Data.Tuple([Data.Bytes({ minLength: 28, maxLength: 28 })]) }),
  Data.Object({ ScriptCredential: Data.Tuple([Data.Bytes({ minLength: 28, maxLength: 28 })]) }),
]);
export type CredentialD = Data.Static<typeof CredentialSchema>;

/**
 * Haskell: PlutusLedgerApi.V1.Credential.StakingCredential
 * StakingHash is Constr 0 [Credential]; StakingPtr (Constr 1) is a legacy form
 * nothing here produces, but it is part of the type so it must be in the schema.
 */
export const StakingCredentialSchema = Data.Enum([
  Data.Object({ StakingHash: Data.Tuple([CredentialSchema]) }),
  Data.Object({ StakingPtr: Data.Tuple([Data.Integer(), Data.Integer(), Data.Integer()]) }),
]);
export type StakingCredentialD = Data.Static<typeof StakingCredentialSchema>;

/**
 * Haskell: PlutusLedgerApi.V1.Address
 *
 *     Address = Address { addressCredential        :: Credential
 *                       , addressStakingCredential :: Maybe StakingCredential }
 *
 * This is the type the auction now records instead of a bare PubKeyHash, which
 * is the whole point: the staking half is what tells you *which* of a key's
 * addresses its owner actually uses. See the note on `Bid` in
 * ../../on-chain/src/AuctionValidator.hs.
 */
export const AddressSchema = Data.Object({
  addressCredential: CredentialSchema,
  addressStakingCredential: Data.Nullable(StakingCredentialSchema),
});
export type AddressD = Data.Static<typeof AddressSchema>;
export const AddressD = AddressSchema as unknown as AddressD;

/** Bech32 address -> the Plutus structure the validator compares against. */
export function toPlutusAddress(bech32: string): AddressD {
  const details = getAddressDetails(bech32);
  const payment = details.paymentCredential;
  if (!payment) {
    throw new Error(`${bech32} has no payment credential; it cannot receive a payout.`);
  }
  const asCredential = (c: { type: "Key" | "Script"; hash: string }): CredentialD =>
    c.type === "Key" ? { PubKeyCredential: [c.hash] } : { ScriptCredential: [c.hash] };

  const stake = details.stakeCredential;
  return {
    addressCredential: asCredential(payment),
    addressStakingCredential: stake ? { StakingHash: [asCredential(stake)] } : null,
  };
}

/** The inverse: the structure from a datum back to an address you can pay. */
export function fromPlutusAddress(addr: AddressD): string {
  const asCredential = (c: CredentialD) =>
    "PubKeyCredential" in c
      ? { type: "Key" as const, hash: c.PubKeyCredential[0] }
      : { type: "Script" as const, hash: c.ScriptCredential[0] };

  const payment = asCredential(addr.addressCredential);
  const stake = addr.addressStakingCredential;
  if (stake === null) return credentialToAddress(network, payment);
  if ("StakingHash" in stake) {
    return credentialToAddress(network, payment, asCredential(stake.StakingHash[0]));
  }
  // StakingPtr: a legacy address form. Nothing in this project creates one, and
  // Lucid cannot rebuild an address from it, so fail loudly rather than guess.
  throw new Error("Pointer staking credentials are not supported.");
}

/**
 * Haskell: data Bid = Bid { bAddress :: Address, bAmount :: Lovelace }
 * makeIsDataSchemaIndexed [('Bid, 0)] => Constr 0 [Address, int]
 *
 * `bAddress` was a `PubKeyHash` until it became clear that a key hash cannot
 * name an address: it identifies who may spend, not where to deliver. Paying a
 * refund from a key hash alone can only ever produce an enterprise address,
 * which the bidder owns but their wallet does not watch.
 */
export const BidSchema = Data.Object({
  bAddress: AddressSchema,
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
 *
 * `apSeller` is an Address for the same reason `Bid.bAddress` is: anyone may
 * submit the payout, so the seller's proceeds must be deliverable by someone
 * who knows nothing about the seller beyond these parameters.
 */
export const AuctionParamsSchema = Data.Object({
  apSeller: AddressSchema,
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
