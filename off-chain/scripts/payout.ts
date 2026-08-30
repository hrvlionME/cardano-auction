/**
 * Settle a closed auction.
 *
 *   deno task payout            # the only auction on disk
 *   deno task payout 1f5c4baf   # ...or any prefix of its policy id
 *
 * Legal only from the auction's end time onward. Anyone can submit this --
 * the validator asks nothing of the signer, only that the outputs are right --
 * though in this demo the seller's wallet does it.
 */
import { awaitTipSlot, awaitUtxo, makeWalletLucid } from "../src/lucid.ts";
import { payout, payoutValidFrom } from "../src/tx/payout.ts";
import { deserialiseParams, loadAuction, saveAuction } from "../src/state.ts";
import { network } from "../src/config.ts";
import { friendlyErrors } from "../src/cli.ts";

friendlyErrors();

const auction = await loadAuction(Deno.args[0]);
const params = deserialiseParams(auction.params);
const lucid = await makeWalletLucid();

const ada = (lovelace: bigint) => `${Number(lovelace) / 1_000_000} ADA`;

console.log(`\nnetwork:  ${network}`);
console.log(`wallet:   ${await lucid.wallet().address()}`);
console.log(`auction:  ${auction.tokenName} at ${auction.address}`);
console.log(`closed:   ${new Date(Number(params.apEndTime)).toISOString()}\n`);

// Wait for the chain to catch up to the deadline before building anything.
// The clock passing the deadline is not enough: the node checks the lower
// validity bound against its tip, which lags by however long since the last block.
const needSlot = lucid.unixTimeToSlot(Number(payoutValidFrom(params)));
await awaitTipSlot(needSlot);

const result = await payout(lucid, auction);

if (result.winnerAddress === null) {
  console.log("no bids: the lot goes back to the seller\n");
} else {
  console.log(`winner:   ${result.winnerAddress}`);
  console.log(`bid:      ${ada(result.winningBid!)}  ->  ${result.sellerAddress}\n`);
}

console.log("submitted:", result.txHash);
console.log("waiting for confirmation (this takes a minute or two)...");
await lucid.awaitTx(result.txHash);
console.log("\nconfirmed -- the validator accepted this transaction\n");

console.log(`  spent auction UTxO:  ${result.spent.txHash}#${result.spent.outputIndex}`);
console.log(`  lot delivered to:    ${result.lotAddress}`);

// Where did the lot actually end up? Polled, not assumed -- see awaitUtxo.
const lotUtxo = await awaitUtxo(lucid, result.lotAddress, result.txHash, { unit: auction.unit });
console.log(`  lot now at:          ${lotUtxo.txHash}#${lotUtxo.outputIndex}`);
console.log(`  holds:               ${lotUtxo.assets.lovelace} lovelace + 1 ${auction.tokenName}`);

const path = await saveAuction({
  ...auction,
  settlement: {
    txHash: result.txHash,
    winnerAddress: result.winnerAddress,
    winningBid: result.winningBid === null ? null : result.winningBid.toString(),
    lotAddress: result.lotAddress,
  },
});
console.log(`\nsaved ${path}`);
console.log(
  `\nThe money is settled. The lot token is now a bearer claim on the item;\n` +
    `burning it (deno task claim) is the winner and seller jointly recording\n` +
    `that the handover happened.\n`,
);
