/**
 * Mint a lot NFT on the configured network.
 *
 *   deno task mint-lot            # token name defaults to LAPTOP
 *   deno task mint-lot MACBOOK
 *
 * Writes state/lot-<policyId>.json so the next transaction can pick it up.
 */
import { makeWalletLucid } from "../src/lucid.ts";
import { mintLot } from "../src/tx/mint-lot.ts";
import { network } from "../src/config.ts";

const tokenName = Deno.args[0] ?? "LAPTOP";

const lucid = await makeWalletLucid();
const address = await lucid.wallet().address();
const utxos = await lucid.wallet().getUtxos();
const balance = utxos.reduce((sum, u) => sum + (u.assets.lovelace ?? 0n), 0n);

console.log(`\nnetwork:  ${network}`);
console.log(`wallet:   ${address}`);
console.log(`balance:  ${Number(balance) / 1_000_000} ADA across ${utxos.length} UTxO(s)`);
console.log(`minting:  "${tokenName}"\n`);

if (balance < 10_000_000n) {
  console.error(
    "Balance is under 10 ADA, which may not cover the fee plus the min-ADA the\n" +
      "token's UTxO needs. Top up at\n" +
      "https://docs.cardano.org/cardano-testnets/tools/faucet\n",
  );
  Deno.exit(1);
}

const lot = await mintLot(lucid, tokenName);

console.log("submitted:", lot.txHash);
console.log("waiting for confirmation (this takes a minute or two)...");
await lucid.awaitTx(lot.txHash);

console.log("\nconfirmed\n");
console.log(`  policy id (CurrencySymbol):  ${lot.policyId}`);
console.log(`  token name (hex):            ${lot.tokenNameHex}`);
console.log(`  unit:                        ${lot.unit}`);
console.log(`  seed UTxO consumed:          ${lot.seed.txHash}#${lot.seed.outputIndex}`);
console.log(`  seller key hash:             ${lot.sellerPkh}`);

await Deno.mkdir("state", { recursive: true });
const statePath = `state/lot-${lot.policyId}.json`;
await Deno.writeTextFile(statePath, JSON.stringify({ ...lot, tokenName, network }, null, 2));
console.log(`\nsaved ${statePath}`);
console.log(
  `\nThe seed UTxO is now spent, so this policy can never mint again.\n` +
    `Use the policy id as apCurrencySymbol when you open the auction.\n`,
);
