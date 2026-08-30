/**
 * Open an auction for an already-minted lot.
 *
 *   deno task open-auction                 # 5 ADA reserve, closes in 20 min
 *   deno task open-auction 10              # 10 ADA reserve
 *   deno task open-auction 10 45           # 10 ADA reserve, closes in 45 min
 *   deno task open-auction 10 45 ae7a1d    # ...on a specific lot
 *
 * Reads state/lot-*.json and writes state/auction-<policyId>.json. The third
 * argument is any prefix of the lot's policy id, and is only needed once you
 * have minted more than one lot -- e.g. a throwaway to test against, so the
 * real one stays clean.
 *
 * Choosing the deadline is a real trade-off in a live demo. Every bid needs a
 * block to confirm (a minute or two on Preview), and `payout` is only legal
 * *from* the deadline onward -- so too short and you cannot get a second bid
 * in, too long and you sit waiting to demonstrate the settlement.
 */
import { awaitUtxo, makeWalletLucid } from "../src/lucid.ts";
import { openAuction } from "../src/tx/open-auction.ts";
import { loadLot, saveAuction, serialiseParams } from "../src/state.ts";
import { network } from "../src/config.ts";
import { friendlyErrors } from "../src/cli.ts";

friendlyErrors();

const reserveAda = Number(Deno.args[0] ?? "5");
const minutes = Number(Deno.args[1] ?? "20");
const lotId = Deno.args[2];

if (!Number.isFinite(reserveAda) || reserveAda <= 0) {
  console.error(`Reserve price must be a positive number of ADA, got "${Deno.args[0]}"`);
  Deno.exit(1);
}
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error(`Duration must be a positive number of minutes, got "${Deno.args[1]}"`);
  Deno.exit(1);
}

const minBid = BigInt(Math.round(reserveAda * 1_000_000));
const endTime = BigInt(Date.now() + minutes * 60_000);

const lot = await loadLot(lotId);
const lucid = await makeWalletLucid();

console.log(`\nnetwork:  ${network}`);
console.log(`wallet:   ${await lucid.wallet().address()}`);
console.log(`lot:      ${lot.tokenName}  (${lot.unit})`);
console.log(`reserve:  ${reserveAda} ADA`);
console.log(`closes:   ${new Date(Number(endTime)).toISOString()}  (in ${minutes} min)\n`);

const opened = await openAuction(lucid, lot, { minBid, endTime });

console.log("submitted:", opened.txHash);
console.log("waiting for confirmation (this takes a minute or two)...");
await lucid.awaitTx(opened.txHash);
console.log("\nconfirmed\n");

// Look the UTxO up rather than guessing its index -- and poll for it, because
// the address index lags the transaction and would otherwise report the UTxO
// this transaction just consumed.
const utxo = await awaitUtxo(lucid, opened.address, opened.txHash, { unit: opened.unit });

console.log(`  auction address:  ${opened.address}`);
console.log(`  auction UTxO:     ${utxo.txHash}#${utxo.outputIndex}`);
console.log(`  datum:            ${opened.datum}   (Nothing -- no bids yet)`);
console.log(`  holds:            ${utxo.assets.lovelace} lovelace + 1 ${lot.tokenName}`);

const path = await saveAuction({
  unit: opened.unit,
  policyId: lot.policyId,
  tokenName: lot.tokenName,
  params: serialiseParams(opened.params),
  address: opened.address,
  datum: opened.datum,
  txHash: opened.txHash,
  utxo: { txHash: utxo.txHash, outputIndex: utxo.outputIndex },
  network,
});
console.log(`\nsaved ${path}`);
console.log(
  `\nThe lot is now locked. It can only move by a transaction the validator\n` +
    `accepts: a bid before ${new Date(Number(endTime)).toISOString()}, or a payout after it.\n`,
);
