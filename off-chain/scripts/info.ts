/**
 * Read-only: what does the configured wallet hold?
 *
 * Submits nothing. Useful before and after every transaction.
 */
import { makeWalletLucid } from "../src/lucid.ts";
import { network } from "../src/config.ts";

const lucid = await makeWalletLucid();
const address = await lucid.wallet().address();
const utxos = await lucid.wallet().getUtxos();

const lovelace = utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);

console.log(`\nnetwork:  ${network}`);
console.log(`address:  ${address}`);
console.log(`balance:  ${Number(lovelace) / 1_000_000} ADA in ${utxos.length} UTxO(s)`);

const tokens = new Map<string, bigint>();
for (const u of utxos) {
  for (const [unit, qty] of Object.entries(u.assets)) {
    if (unit === "lovelace") continue;
    tokens.set(unit, (tokens.get(unit) ?? 0n) + qty);
  }
}

if (tokens.size > 0) {
  console.log(`\nnative tokens:`);
  for (const [unit, qty] of tokens) {
    console.log(`  ${qty}  ${unit.slice(0, 56)}…${unit.length > 56 ? unit.slice(56) : ""}`);
  }
} else {
  console.log(`\nnative tokens: none`);
}
console.log();
