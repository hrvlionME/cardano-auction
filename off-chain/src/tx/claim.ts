/**
 * Claim the item: burn the lot token.
 *
 * The token is a bearer claim on the physical thing. Burning it is the winner
 * redeeming that claim, and it closes the lifecycle the minting policy was
 * written around: mint -> auction -> deliver -> burn. Without a burn path the
 * coupon would live forever and nothing on-chain would distinguish a claim
 * already redeemed from one still outstanding.
 *
 * The burn branch of the policy asks for one thing: the seller's signature.
 * Spending the token needs the holder's key regardless, so a burn is a
 * two-party receipt -- it can only exist if both sides were present.
 *
 * That makes this the one transaction here that can need two signatures, and
 * it exposes a Cardano detail worth knowing: `txInfoSignatories` is built from
 * the transaction body's *required signers* field, not from whichever keys
 * happen to have witnessed it. A transaction the seller signed but that never
 * declared them a required signer shows the policy an empty list and fails.
 * Hence `addSignerKey` below -- it is load-bearing, not decoration.
 */
import {
  Data,
  mintingPolicyToId,
  paymentCredentialOf,
  walletFromSeed,
} from "@lucid-evolution/lucid";
import type { Lucid } from "../lucid.ts";
import { lotPolicyScript } from "../blueprint.ts";
import type { LotParams } from "../types.ts";
import type { LotState } from "../state.ts";
import { network } from "../config.ts";

export interface Claimed {
  /** Who held the token and is redeeming the claim. */
  holderPkh: string;
  /** Whether the seller's signature had to be gathered separately. */
  coSigned: boolean;
  /** The UTxO that held the token, now spent. */
  spent: { txHash: string; outputIndex: number };
  txHash: string;
}

export interface ClaimOptions {
  /**
   * The seller's seed phrase, needed only when the holder is not the seller.
   * When an auction closed with no bids the lot returns to the seller, who is
   * then both parties, and one signature covers both roles.
   */
  sellerSeed?: string;
}

export async function claim(
  lucid: Lucid,
  lot: LotState,
  { sellerSeed }: ClaimOptions = {},
): Promise<Claimed> {
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
        `Rebuild the blueprint (cd ../on-chain && make blueprint).`,
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

  const sellerIsHolder = holderPkh === lot.sellerPkh;
  if (!sellerIsHolder && !sellerSeed) {
    throw new Error(
      `Burning ${lot.tokenName} needs the seller's signature as well as yours.\n` +
        `  seller: ${lot.sellerPkh}\n` +
        `  holder: ${holderPkh}\n` +
        `Set WALLET_SEED_PHRASE to the seller's wallet so both can sign.`,
    );
  }

  const completed = await lucid
    .newTx()
    // Explicit, though balancing would find it: burning requires the token to
    // be among the inputs, and saying so makes the transaction self-describing.
    .collectFrom([tokenUtxo])
    // -1: the policy allows exactly two quantities, 1 (mint) and -1 (burn),
    // and dispatches to a different rule for each. The redeemer is ignored.
    .mintAssets({ [lot.unit]: -1n }, Data.void())
    .attach.MintingPolicy(policy)
    // Load-bearing: this is what puts the seller into `txInfoSignatories`.
    // It also makes the ledger refuse the transaction without that signature,
    // so the requirement is enforced twice over.
    .addSignerKey(lot.sellerPkh)
    // Evaluate on the node: Lucid's bundled evaluator predates plutus-tx 1.67
    // and dies decoding the ScriptContext before our logic ever runs.
    .complete({ localUPLCEval: false });

  let txHash: string;
  if (sellerIsHolder) {
    // One key, both roles -- the no-bid path, where the lot came home.
    txHash = await (await completed.sign.withWallet().complete()).submit();
  } else {
    // Two parties. Each signs the *same* built transaction independently and
    // the witnesses are assembled afterwards; neither side re-balances or
    // otherwise alters it. In a real deployment the unsigned transaction would
    // travel between two machines and only the witnesses would come back.
    //
    // The seller signs with a key derived from their seed rather than by
    // switching this Lucid instance's wallet, which would leave the caller
    // holding an instance quietly pointed at someone else's wallet.
    const sellerKey = walletFromSeed(sellerSeed!, { network }).paymentKey;
    const witnesses = await Promise.all([
      completed.partialSign.withWallet(),
      completed.partialSign.withPrivateKey(sellerKey),
    ]);
    txHash = await (await completed.assemble(witnesses).complete()).submit();
  }

  return {
    holderPkh,
    coSigned: !sellerIsHolder,
    spent: { txHash: tokenUtxo.txHash, outputIndex: tokenUtxo.outputIndex },
    txHash,
  };
}
