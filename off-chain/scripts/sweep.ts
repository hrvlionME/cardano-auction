/**
 * Move everything sitting at a key's enterprise address into its base address.
 *
 *   deno task sweep
 *
 * Why this is needed at all is a finding, not an accident. `Bid` stores only a
 * `PubKeyHash`, so whoever settles an auction can reconstruct the winner's
 * payment key and nothing else -- not their staking credential, hence not
 * their real address. The best it can build is an enterprise address. The
 * validator is satisfied (`toPubKeyHash` ignores the staking part) and the
 * winner genuinely controls the funds, but their everyday wallet watches only
 * its base address, so the payout looks like it went nowhere.
 *
 * Sweeping is the user-facing repair. The real repair is on-chain: store an
 * `Address` in the datum rather than a `PubKeyHash`, at the cost of a larger
 * datum and of having to validate a structure the bidder supplied.
 */
import { makeWalletLucid } from "../src/lucid.ts";
import { bidderIndices, bidderSeedPhrase, network, walletSeedPhrase } from "../src/config.ts";
import { friendlyErrors } from "../src/cli.ts";

friendlyErrors();

const wallets: { name: string; seed: string }[] = [
  { name: "seller", seed: walletSeedPhrase() },
  ...bidderIndices().map((n) => ({ name: `bidder ${n}`, seed: bidderSeedPhrase(n) })),
];

console.log(`\nnetwork: ${network}\n`);

for (const { name, seed } of wallets) {
  const enterprise = await makeWalletLucid(seed, "Enterprise");
  const base = await makeWalletLucid(seed, "Base");
  const from = await enterprise.wallet().address();
  const to = await base.wallet().address();

  const utxos = await enterprise.wallet().getUtxos();
  if (utxos.length === 0) {
    console.log(`${name}: nothing at ${from}`);
    continue;
  }

  const lovelace = utxos.reduce((n, u) => n + (u.assets.lovelace ?? 0n), 0n);
  const tokens = utxos.flatMap((u) => Object.keys(u.assets).filter((k) => k !== "lovelace"));
  console.log(`${name}: ${utxos.length} UTxO(s) at the enterprise address`);
  console.log(`  ${Number(lovelace) / 1_000_000} ADA` + (tokens.length ? ` + ${tokens.length} token(s)` : ""));
  console.log(`  ${from}\n  -> ${to}`);

  // Spend every enterprise UTxO and direct the change to the base address.
  // No explicit outputs: whatever is left after the fee -- ADA and tokens
  // alike -- lands in the change output, which is exactly the whole balance.
  const tx = await enterprise.newTx().collectFrom(utxos).complete({ changeAddress: to });
  const txHash = await (await tx.sign.withWallet().complete()).submit();

  console.log(`  submitted: ${txHash}`);
  await enterprise.awaitTx(txHash);
  console.log(`  confirmed\n`);
}
