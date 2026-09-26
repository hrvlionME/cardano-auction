/**
 * Claim the item: burn the lot token.
 *
 * The token is a bearer claim on the physical thing. Burning it is the winner
 * redeeming that claim -- their confirmation that the item arrived -- and it
 * closes the lifecycle the minting policy was written around: mint -> auction
 * -> deliver -> burn. Without a burn path the coupon would live forever and
 * nothing on-chain would distinguish a claim already redeemed from one still
 * outstanding.
 *
 * One signature: the holder's. The burn branch of the policy asks for nothing
 * more, because spending the UTxO that holds the token already requires the
 * holder's key, and the ledger checks that before the policy runs.
 *
 * It used to need the seller's signature too, as a two-party handshake. That
 * was dropped: a browser wallet signs only for itself, so it took a relay
 * between two people, and co-signing put the seller at risk of signing a
 * "burn" that also spent their own funds. See LotMintingPolicy.hs.
 */
import { Data, mintingPolicyToId, paymentCredentialOf } from "@lucid-evolution/lucid";
import type { Lucid } from "../lucid.ts";
import { lotPolicyScript } from "../blueprint.ts";
import type { LotParams } from "../types.ts";
import type { LotState } from "../state.ts";

export interface Claimed {
  /** Who held the token and is redeeming the claim. */
  holderPkh: string;
  /** The UTxO that held the token, now spent. */
  spent: { txHash: string; outputIndex: number };
  txHash: string;
}

export async function claim(lucid: Lucid, lot: LotState): Promise<Claimed> {
  const holderAddress = await lucid.wallet().address();
  const holderPkh = paymentCredentialOf(holderAddress).hash;

  const params: LotParams = {
    lpSeedRef: { txOutRefId: lot.seed.txHash, txOutRefIdx: BigInt(lot.seed.outputIndex) },
    lpTokenName: lot.tokenNameHex,
    lpSeller: lot.sellerPkh,
  };
  const policy = await lotPolicyScript(params);

  // The policy id is the hash of the parameterised script, so this catches the
  // same drift `verify-lot` looks for: if the Haskell moved, the policy we are
  // about to attach is not the one that minted this token, and the ledger will
  // reject the burn for a reason that mentions none of this.
  const derivedPolicyId = mintingPolicyToId(policy);
  if (derivedPolicyId !== lot.policyId) {
    throw new Error(
      `Script drift: this code no longer produces the policy that minted ${lot.tokenName}.\n` +
        `  minted under:     ${lot.policyId}\n` +
        `  code now derives: ${derivedPolicyId}\n` +
        `Lots minted before the Haskell last changed keep the rule they were minted\n` +
        `under, and this code cannot burn them. Mint a fresh lot, or rebuild the\n` +
        `blueprint if it is merely stale (cd ../on-chain && make blueprint).`,
    );
  }

  // The token is unique, so this finds it wherever it is -- and tells us
  // whether the wallet driving this actually holds it.
  const utxos = await lucid.wallet().getUtxos();
  const tokenUtxo = utxos.find((u) => (u.assets[lot.unit] ?? 0n) > 0n);
  if (!tokenUtxo) {
    throw new Error(
      `This wallet does not hold ${lot.tokenName}.\n` +
        `  wallet: ${holderAddress}\n` +
        `Only the holder can burn it. If the auction has not been settled yet, ` +
        `run \`deno task payout\` first.`,
    );
  }

  const completed = await lucid
    .newTx()
    // Explicit, though balancing would find it: burning requires the token to
    // be among the inputs, and saying so makes the transaction self-describing.
    // It is also what makes the holder's signature necessary.
    .collectFrom([tokenUtxo])
    // -1: the policy allows exactly two quantities, 1 (mint) and -1 (burn),
    // and dispatches to a different rule for each. The redeemer is ignored.
    .mintAssets({ [lot.unit]: -1n }, Data.void())
    .attach.MintingPolicy(policy)
    // Evaluate on the node: Lucid's bundled evaluator predates plutus-tx 1.67
    // and dies decoding the ScriptContext before our logic ever runs.
    .complete({ localUPLCEval: false });

  const txHash = await (await completed.sign.withWallet().complete()).submit();

  return {
    holderPkh,
    spent: { txHash: tokenUtxo.txHash, outputIndex: tokenUtxo.outputIndex },
    txHash,
  };
}
