/**
 * Checks that the current code still reproduces an already-minted lot.
 *
 * The policy id is the hash of the parameterised script, so any change to the
 * Haskell -- or to how parameters are applied -- moves it. If that happens,
 * tokens already on-chain no longer belong to the policy your code derives,
 * and every address you compute is wrong. Run this after touching on-chain.
 */
import { mintingPolicyToId } from "@lucid-evolution/lucid";
import { lotPolicyScript } from "../src/blueprint.ts";

let failures = 0;
for await (const entry of Deno.readDir("state")) {
  if (!entry.isFile || !entry.name.startsWith("lot-")) continue;
  const saved = JSON.parse(await Deno.readTextFile(`state/${entry.name}`));

  const policy = await lotPolicyScript({
    lpSeedRef: {
      txOutRefId: saved.seed.txHash,
      txOutRefIdx: BigInt(saved.seed.outputIndex),
    },
    lpTokenName: saved.tokenNameHex,
    lpSeller: saved.sellerPkh,
  });
  const derived = mintingPolicyToId(policy);

  if (derived === saved.policyId) {
    console.log(`  ok    ${saved.tokenName}: ${derived}`);
  } else {
    failures++;
    console.log(`  DRIFT ${saved.tokenName}`);
    console.log(`        on-chain: ${saved.policyId}`);
    console.log(`        derived:  ${derived}`);
  }
}
console.log(failures === 0 ? "\nminted lots still match the current code\n" : "\nSCRIPTS CHANGED\n");
Deno.exit(failures === 0 ? 0 : 1);
