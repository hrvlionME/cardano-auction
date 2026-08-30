/**
 * Place a bid on an open auction.
 *
 *   deno task bid 7                  # bidder 1 bids 7 ADA
 *   deno task bid 9 --as 2           # bidder 2 outbids
 *   deno task bid 9 --as 2 1f5c4baf  # ...on a specific auction
 *
 * Bids from BIDDER<n>_SEED_PHRASE, defaulting to bidder 1, and falls back to
 * the seller's own wallet if no bidder is configured. Nothing in the contract
 * forbids the seller bidding on their own auction, but it makes for a thin
 * demonstration: the refund never leaves for a third party, which is the
 * interesting half of this transaction.
 */
import { awaitUtxo, makeBidderLucid, makeWalletLucid } from "../src/lucid.ts";
import { bid } from "../src/tx/bid.ts";
import { deserialiseParams, loadAuction } from "../src/state.ts";
import { bidderIndices, network } from "../src/config.ts";
import { friendlyErrors } from "../src/cli.ts";

friendlyErrors();

// `--as N` selects the bidder; everything else stays positional.
const args = [...Deno.args];
let bidderNo = 1;
const asAt = args.indexOf("--as");
if (asAt !== -1) {
  bidderNo = Number(args[asAt + 1]);
  args.splice(asAt, 2);
}

const ada = Number(args[0]);
if (!Number.isFinite(ada) || ada <= 0) {
  console.error(`Usage: deno task bid <amount in ADA> [--as <bidder>] [auction id]`);
  Deno.exit(1);
}
const amount = BigInt(Math.round(ada * 1_000_000));

const auction = await loadAuction(args[1]);
const params = deserialiseParams(auction.params);

const configured = bidderIndices();
if (asAt !== -1 && !configured.includes(bidderNo)) {
  console.error(
    `No BIDDER${bidderNo}_SEED_PHRASE in .env. Configured bidders: ` +
      `${configured.join(", ") || "none"}`,
  );
  Deno.exit(1);
}
const asBidder = configured.length > 0;
const lucid = asBidder ? await makeBidderLucid(bidderNo) : await makeWalletLucid();

console.log(`\nnetwork:  ${network}`);
console.log(`bidding:  ${ada} ADA on ${auction.tokenName}`);
console.log(`bidder:   ${asBidder ? `#${bidderNo}` : "the seller (no bidder wallets configured)"}`);
console.log(`wallet:   ${await lucid.wallet().address()}`);
if (!asBidder) {
  console.log(`          (set BIDDER1_SEED_PHRASE / BIDDER2_SEED_PHRASE for real`);
  console.log(`           bidders, so refunds travel between separate parties)`);
}
console.log(`closes:   ${new Date(Number(params.apEndTime)).toISOString()}\n`);

const placed = await bid(lucid, auction, amount);

if (placed.refund) {
  console.log(
    `refunding ${Number(placed.refund.amount) / 1_000_000} ADA to the previous ` +
      `leader ${placed.refund.pkh.slice(0, 16)}...`,
  );
} else {
  console.log("opening bid: nobody to refund");
}

console.log("\nsubmitted:", placed.txHash);
console.log("waiting for confirmation (this takes a minute or two)...");
await lucid.awaitTx(placed.txHash);
console.log("\nconfirmed -- the validator accepted this bid\n");

// Read the new auction state back off the chain rather than assuming it.
const utxo = await awaitUtxo(lucid, auction.address, placed.txHash, { unit: auction.unit });
console.log(`  spent auction UTxO:  ${placed.spent.txHash}#${placed.spent.outputIndex}`);
console.log(`  new auction UTxO:    ${utxo.txHash}#${utxo.outputIndex}`);
console.log(`  now holds:           ${utxo.assets.lovelace} lovelace + 1 ${auction.tokenName}`);
console.log(`  datum:               ${utxo.datum}`);
console.log(
  `\nThe lot has not moved -- it is still locked at the same address. Only the\n` +
    `datum and the ADA changed. Bid again to displace this bid, or wait for\n` +
    `${new Date(Number(params.apEndTime)).toISOString()} and run \`deno task payout\`.\n`,
);
