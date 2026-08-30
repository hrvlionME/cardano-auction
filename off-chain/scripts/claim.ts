/**
 * Burn the lot token: the winner redeeming their claim on the physical item.
 *
 *   deno task claim             # the only lot on disk
 *   deno task claim 1f5c4baf    # ...or any prefix of its policy id
 *
 * The burn needs the seller's signature as well as the holder's, so this is
 * the one transaction here that can carry two. Whoever holds the token drives
 * it; the seller co-signs. When an auction closed with no bids the lot came
 * home to the seller, who is then both parties at once.
 */
import { paymentCredentialOf } from "@lucid-evolution/lucid";
import { awaitBurned, makeBidderLucid, makeWalletLucid } from "../src/lucid.ts";
import { claim } from "../src/tx/claim.ts";
import { loadLot } from "../src/state.ts";
import { bidderIndices, network, walletSeedPhrase } from "../src/config.ts";
import type { Lucid } from "../src/lucid.ts";
import { friendlyErrors } from "../src/cli.ts";

friendlyErrors();

const lot = await loadLot(Deno.args[0]);

/**
 * Whoever actually holds the token drives the transaction. Find them.
 *
 * Only each party's real wallet address is checked. `payout` now delivers the
 * lot to the address the winner named in their own bid, so there is no second
 * address to go looking in -- which is exactly what the datum change bought.
 */
async function findHolder(): Promise<{ lucid: Lucid; isSeller: boolean; where: string }> {
  const candidates: { lucid: Lucid; isSeller: boolean; where: string }[] = [
    { lucid: await makeWalletLucid(), isSeller: true, where: "seller" },
  ];
  for (const n of bidderIndices()) {
    candidates.push({
      lucid: await makeBidderLucid(n),
      isSeller: false,
      where: `bidder ${n}`,
    });
  }

  const looked: string[] = [];
  for (const c of candidates) {
    const utxos = await c.lucid.wallet().getUtxos();
    if (utxos.some((u) => (u.assets[lot.unit] ?? 0n) > 0n)) return c;
    looked.push(`  ${c.where.padEnd(10)} ${await c.lucid.wallet().address()}`);
  }
  throw new Error(
    `None of these addresses holds ${lot.tokenName} (${lot.unit}):\n` +
      looked.join("\n") +
      `\nIf the auction is still open or unsettled, run \`deno task payout\` first.`,
  );
}

const { lucid, isSeller, where } = await findHolder();
const holderAddress = await lucid.wallet().address();

console.log(`\nnetwork:  ${network}`);
console.log(`burning:  ${lot.tokenName} (${lot.unit})`);
console.log(`holder:   ${holderAddress}`);
console.log(`          found as ${where}`);
console.log(`seller:   ${lot.sellerPkh}`);
console.log(
  isSeller
    ? `signing:  one key -- the holder is the seller, so both roles are the same person\n`
    : `signing:  two keys -- the holder redeems, the seller co-signs the handover\n`,
);

const result = await claim(lucid, lot, {
  // Only needed when they are different people. `walletSeedPhrase` is the
  // seller's, since the seller is the operator running this demo.
  sellerSeed: isSeller ? undefined : walletSeedPhrase(),
});

console.log("submitted:", result.txHash);
console.log("waiting for confirmation (this takes a minute or two)...");
await lucid.awaitTx(result.txHash);
console.log("\nconfirmed -- the policy accepted the burn\n");

console.log(`  spent token UTxO:  ${result.spent.txHash}#${result.spent.outputIndex}`);
console.log(`  co-signed:         ${result.coSigned}`);

// The token should now not exist anywhere. Prove it against the asset's total
// supply rather than against a wallet, whose index lags a fresh burn.
const supply = await awaitBurned(lot.unit);
console.log(`  total supply now:  ${supply.quantity}`);
console.log(`  mint/burn events:  ${supply.events}`);

console.log(
  `\nThe claim is redeemed and the token is gone. The chain now records that\n` +
    `the seller and the holder both signed off on the handover -- which is the\n` +
    `most a ledger can say about a physical object.\n`,
);
