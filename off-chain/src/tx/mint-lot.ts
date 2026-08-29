/**
 * Mint the lot NFT: the token that stands for the physical item.
 *
 * This is the first transaction in the auction lifecycle, and it must come
 * first for a structural reason. The auction validator is parameterised by the
 * lot's CurrencySymbol, and that symbol *is* the minting policy's hash, which
 * depends on the seed UTxO chosen here. So there is no auction address to
 * compute until the token exists.
 *
 * The policy is one-shot: it demands that one specific UTxO be consumed. A
 * UTxO can be spent once in the history of the chain, so the policy can
 * succeed once, and the token is provably unique.
 */
import { Data, fromText, mintingPolicyToId, paymentCredentialOf } from "@lucid-evolution/lucid";
import type { Lucid } from "../lucid.ts";
import { lotPolicyScript } from "../blueprint.ts";
import type { LotParams } from "../types.ts";

/** Assets is a record lookup, so lovelace may be absent on a token-only UTxO. */
const lovelaceOf = (u: { assets: Record<string, bigint> }): bigint => u.assets.lovelace ?? 0n;

export interface MintedLot {
  /** Policy id, i.e. the minting policy's script hash. Also the CurrencySymbol. */
  policyId: string;
  /** Token name, hex-encoded, as it appears on-chain. */
  tokenNameHex: string;
  /** policyId + tokenNameHex: how Lucid names an asset. */
  unit: string;
  /** The UTxO consumed to make the mint unrepeatable. */
  seed: { txHash: string; outputIndex: number };
  /** Seller / operator key hash, baked into the policy for the burn rule. */
  sellerPkh: string;
  txHash: string;
}

/**
 * Picks a seed UTxO from the wallet, parameterises the policy with it, and
 * mints exactly one token.
 */
export async function mintLot(lucid: Lucid, tokenName: string): Promise<MintedLot> {
  const address = await lucid.wallet().address();
  const utxos = await lucid.wallet().getUtxos();

  if (utxos.length === 0) {
    throw new Error(
      `Wallet ${address} has no UTxOs.\n` +
        `Fund it from https://docs.cardano.org/cardano-testnets/tools/faucet`,
    );
  }

  // Any UTxO will do as the seed; the largest keeps enough change for fees
  // and for the min-ADA the token's own UTxO will need.
  const seedUtxo = utxos.reduce((a, b) => (lovelaceOf(b) > lovelaceOf(a) ? b : a));

  const sellerPkh = paymentCredentialOf(address).hash;
  const tokenNameHex = fromText(tokenName);

  const params: LotParams = {
    lpSeedRef: {
      txOutRefId: seedUtxo.txHash,
      txOutRefIdx: BigInt(seedUtxo.outputIndex),
    },
    lpTokenName: tokenNameHex,
    lpSeller: sellerPkh,
  };

  const policy = await lotPolicyScript(params);
  const policyId = mintingPolicyToId(policy);
  const unit = policyId + tokenNameHex;

  const tx = await lucid
    .newTx()
    // Consuming the seed is the whole uniqueness argument. Without this input
    // the policy rejects, and it can never be satisfied again afterwards.
    .collectFrom([seedUtxo])
    // The policy ignores its redeemer; unit is the conventional filler.
    .mintAssets({ [unit]: 1n }, Data.void())
    .attach.MintingPolicy(policy)
    // Evaluate script budgets on the node via Blockfrost rather than in
    // Lucid's bundled evaluator. That evaluator is older than plutus-tx 1.67
    // and rejects the UPLC our scripts compile to, failing with "attempted to
    // case a non-const Value" while it decodes the ScriptContext. The node
    // handles it, and is the authority on what will actually be accepted.
    .complete({ localUPLCEval: false });

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  return {
    policyId,
    tokenNameHex,
    unit,
    seed: { txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex },
    sellerPkh,
    txHash,
  };
}
