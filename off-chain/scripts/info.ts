/**
 * Read-only: where is everything right now?
 *
 * Submits nothing, costs nothing, and is the command to run between every step
 * of a demonstration -- it shows the same state from three angles at once: what
 * each party holds, and what each auction currently contains.
 */
import { Data } from "@lucid-evolution/lucid";
import { makeBidderLucid, makeWalletLucid, type Lucid } from "../src/lucid.ts";
import { auctionAddress } from "../src/blueprint.ts";
import { AuctionDatum, fromPlutusAddress } from "../src/types.ts";
import { type AuctionState, deserialiseParams } from "../src/state.ts";
import { bidderIndices, network } from "../src/config.ts";
import { friendlyErrors } from "../src/cli.ts";

friendlyErrors();

const ada = (n: bigint) => `${(Number(n) / 1_000_000).toFixed(6)} ADA`;

/** Every party we know about, so a payment can be attributed to a name. */
const parties: { name: string; lucid: Lucid }[] = [
  { name: "seller", lucid: await makeWalletLucid() },
];
for (const n of bidderIndices()) {
  parties.push({ name: `bidder ${n}`, lucid: await makeBidderLucid(n) });
}

const addressOf = new Map<string, string>();
for (const p of parties) addressOf.set(await p.lucid.wallet().address(), p.name);

/** Name an address if we hold its key, otherwise show it truncated. */
const whose = (addr: string) => addressOf.get(addr) ?? `${addr.slice(0, 20)}…`;

console.log(`\nnetwork: ${network}`);

console.log(`\nwallets`);
for (const { name, lucid } of parties) {
  const address = await lucid.wallet().address();
  const utxos = await lucid.wallet().getUtxos();
  const lovelace = utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);

  const tokens = new Map<string, bigint>();
  for (const u of utxos) {
    for (const [unit, qty] of Object.entries(u.assets)) {
      if (unit !== "lovelace") tokens.set(unit, (tokens.get(unit) ?? 0n) + qty);
    }
  }

  console.log(`  ${name.padEnd(9)} ${ada(lovelace).padStart(16)}  ${utxos.length} UTxO(s)`);
  console.log(`  ${" ".repeat(9)} ${address}`);
  for (const [unit, qty] of tokens) {
    console.log(`  ${" ".repeat(9)} holds ${qty} x ${unit.slice(0, 56)}…`);
  }
}

// Auctions on disk. Each is looked up on-chain rather than trusted from state.
const auctions: AuctionState[] = [];
try {
  for await (const e of Deno.readDir("state")) {
    if (e.isFile && e.name.startsWith("auction-")) {
      auctions.push(JSON.parse(await Deno.readTextFile(`state/${e.name}`)));
    }
  }
} catch { /* no state directory yet */ }

console.log(`\nauctions`);
if (auctions.length === 0) console.log("  none on disk");

const reader = parties[0]!.lucid;
for (const a of auctions) {
  const params = deserialiseParams(a.params);
  const address = await auctionAddress(params);
  const closes = new Date(Number(params.apEndTime));
  const closed = Date.now() > Number(params.apEndTime);

  console.log(`\n  ${a.tokenName}  reserve ${ada(params.apMinBid)}`);
  console.log(`    address:  ${address}`);
  console.log(`    seller:   ${whose(fromPlutusAddress(params.apSeller))}`);
  console.log(`    closes:   ${closes.toISOString()}  ${closed ? "(CLOSED)" : "(open)"}`);
  if (address !== a.address) {
    console.log(`    WARNING:  saved address differs -- the scripts have changed since`);
  }

  const utxo = (await reader.utxosAt(address)).find((u) => (u.assets[a.unit] ?? 0n) > 0n);
  if (!utxo) {
    const s = a.settlement;
    console.log(`    state:    settled${s ? ` in ${s.txHash.slice(0, 16)}…` : ""}`);
    if (s?.winnerAddress) console.log(`    winner:   ${whose(s.winnerAddress)}`);
    continue;
  }

  const bid = utxo.datum ? Data.from(utxo.datum, AuctionDatum) : null;
  console.log(`    utxo:     ${utxo.txHash}#${utxo.outputIndex}`);
  console.log(`    holds:    ${ada(utxo.assets.lovelace ?? 0n)} + 1 ${a.tokenName}`);
  if (bid === null) {
    console.log(`    bids:     none yet -- first bid must clear ${ada(params.apMinBid)}`);
  } else {
    console.log(`    leader:   ${whose(fromPlutusAddress(bid.bAddress))} at ${ada(bid.bAmount)}`);
    console.log(`    next bid: must exceed ${ada(bid.bAmount)}`);
  }
}
console.log();
