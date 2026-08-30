/**
 * Offline sanity check: no network, no wallet, no Blockfrost key needed.
 *
 * Verifies that the blueprint loads, both scripts are present and can have
 * parameters applied, and -- most importantly -- that the Plutus data
 * encodings match what the Haskell side expects.
 */
import { assert, assertEquals } from "@std/assert";
import { credentialToAddress, Data } from "@lucid-evolution/lucid";
import {
  AUCTION_VALIDATOR,
  auctionAddress,
  auctionScript,
  LOT_MINTING_POLICY,
  lotPolicyScript,
  rawValidator,
} from "../src/blueprint.ts";
import {
  AddressD,
  AuctionDatum,
  AuctionDatumSchema,
  AuctionRedeemer,
  AuctionRedeemerSchema,
  fromPlutusAddress,
  settlementTag,
  toPlutusAddress,
} from "../src/types.ts";
import { network } from "../src/config.ts";

const ok = (msg: string) => console.log(`  ok  ${msg}`);

// A 28-byte pubkey hash and a 32-byte tx id, as hex.
const PKH = "00".repeat(28);
const STAKE = "22".repeat(28);
const TXID = "11".repeat(32);

// The same payment key, as the two addresses it can form. Telling these apart
// is the entire reason Bid stores an Address rather than a PubKeyHash.
const ENTERPRISE = credentialToAddress(network, { type: "Key", hash: PKH });
const BASE = credentialToAddress(network, { type: "Key", hash: PKH }, {
  type: "Key",
  hash: STAKE,
});

console.log("\nblueprint");
const auction = await rawValidator(AUCTION_VALIDATOR);
const lot = await rawValidator(LOT_MINTING_POLICY);
ok(`${AUCTION_VALIDATOR}: ${auction.compiledCode.length / 2} bytes, hash ${auction.hash.slice(0, 16)}…`);
ok(`${LOT_MINTING_POLICY}: ${lot.compiledCode.length / 2} bytes, hash ${lot.hash.slice(0, 16)}…`);

console.log("\ndata encodings (must match PlutusTx: Constr 0 = d879, Constr 1 = d87a)");

// Maybe Bid: Just => Constr 0, Nothing => Constr 1.
const withBid = Data.to({ bAddress: toPlutusAddress(BASE), bAmount: 60_000_000n }, AuctionDatum);
const noBid = Data.to(null, AuctionDatum);
assert(withBid.startsWith("d879"), `Just Bid should be Constr 0, got ${withBid.slice(0, 8)}`);
assert(noBid.startsWith("d87a"), `Nothing should be Constr 1, got ${noBid.slice(0, 8)}`);
ok("AuctionDatum: Just => Constr 0, Nothing => Constr 1");

// Round-trip through the schema.
const back = Data.from(withBid, AuctionDatum);
assertEquals(back?.bAmount, 60_000_000n);
assertEquals(fromPlutusAddress(back!.bAddress), BASE);
ok("AuctionDatum round-trips");

// AuctionRedeemer: NewBid => Constr 0, Payout => Constr 1.
const newBid = Data.to(
  { NewBid: [{ bAddress: toPlutusAddress(BASE), bAmount: 60_000_000n }] },
  AuctionRedeemer,
);
const payout = Data.to("Payout", AuctionRedeemer);
assert(newBid.startsWith("d879"), `NewBid should be Constr 0, got ${newBid.slice(0, 8)}`);
assert(payout.startsWith("d87a"), `Payout should be Constr 1, got ${payout.slice(0, 8)}`);
ok("AuctionRedeemer: NewBid => Constr 0, Payout => Constr 1");

// The double-satisfaction tag: TxOutRef is Constr 0 [bytes, int].
const tag = settlementTag(TXID, 0);
assert(tag.startsWith("d879"), `TxOutRef should be Constr 0, got ${tag.slice(0, 8)}`);
assert(tag.includes(TXID), "tag must embed the tx id as plain bytes (TxId is a transparent newtype)");
ok("settlement tag: TxOutRef => Constr 0 [bytes, int]");

console.log("\naddresses (why Bid stores an Address, not a PubKeyHash)");
const baseHex = Data.to(toPlutusAddress(BASE), AddressD);
const entHex = Data.to(toPlutusAddress(ENTERPRISE), AddressD);
assert(
  baseHex !== entHex,
  "base and enterprise addresses on the same key must not encode identically -- " +
    "if they do, a refund can be paid to an address the bidder never named",
);
ok("base and enterprise addresses on one key encode differently");
assertEquals(fromPlutusAddress(toPlutusAddress(BASE)), BASE);
assertEquals(fromPlutusAddress(toPlutusAddress(ENTERPRISE)), ENTERPRISE);
ok("addresses round-trip through the Plutus encoding");

console.log("\nparameter application");
const params = {
  apSeller: toPlutusAddress(BASE),
  apCurrencySymbol: "22".repeat(28),
  apTokenName: "4c4150544f50", // "LAPTOP"
  apMinBid: 50_000_000n,
  apEndTime: 1_700_000_000_000n,
};
const applied = await auctionScript(params);
assert(applied.script.length > auction.compiledCode.length, "applying params should grow the script");
ok(`auction script parameterised: ${applied.script.length / 2} bytes`);

const addr = await auctionAddress(params);
assert(addr.startsWith("addr_test"), `expected a testnet address, got ${addr.slice(0, 12)}`);
ok(`auction address: ${addr.slice(0, 32)}…`);

const policy = await lotPolicyScript({
  lpSeedRef: { txOutRefId: TXID, txOutRefIdx: 0n },
  lpTokenName: "4c4150544f50",
  lpSeller: PKH,
});
assert(policy.script.length > lot.compiledCode.length, "applying params should grow the policy");
ok(`lot policy parameterised: ${policy.script.length / 2} bytes`);

console.log("\nall checks passed\n");
