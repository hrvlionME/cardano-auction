/** Lucid instance construction. */
import { Blockfrost, Lucid, type UTxO } from "@lucid-evolution/lucid";
import {
  bidderSeedPhrase,
  blockfrostProjectId,
  blockfrostUrl,
  network,
  walletSeedPhrase,
} from "./config.ts";

/** Derived rather than imported by name, so a rename upstream cannot silently rot. */
export type Lucid = Awaited<ReturnType<typeof Lucid>>;

/** Read-only: can query the chain, cannot sign. */
export function makeLucid(): Promise<Lucid> {
  return Lucid(new Blockfrost(blockfrostUrl(), blockfrostProjectId()), network);
}

/**
 * Signing-capable. Defaults to the seller/operator wallet from .env.
 *
 * The seed is read inside the default argument, so it is only demanded when a
 * caller actually wants that wallet -- passing an explicit seed never touches
 * WALLET_SEED_PHRASE.
 */
export async function makeWalletLucid(seed: string = walletSeedPhrase()): Promise<Lucid> {
  const lucid = await makeLucid();
  lucid.selectWallet.fromSeed(seed);
  return lucid;
}

/** Bidder n, from BIDDER<n>_SEED_PHRASE. */
export function makeBidderLucid(n: number): Promise<Lucid> {
  return makeWalletLucid(bidderSeedPhrase(n));
}

/**
 * Wait until the chain index actually shows an output of `txHash` at `address`.
 *
 * `awaitTx` returns once the transaction is on-chain, but Blockfrost's
 * per-address index trails that by a few seconds. Reading straight after
 * confirmation therefore returns the state *before* the transaction: during
 * development this reported a freshly opened auction as still sitting at the
 * UTxO the opening transaction had just consumed.
 *
 * `utxoByUnit` is no safer -- for a token at a script address it came back
 * undefined rather than raising -- so every read-back goes through here.
 * Polling an address for an expected transaction hash is the one form that
 * cannot quietly answer with stale data: either the output is there or we
 * keep waiting.
 */
export async function awaitUtxo(
  lucid: Lucid,
  address: string,
  txHash: string,
  { unit, tries = 24, delayMs = 5_000 }: { unit?: string; tries?: number; delayMs?: number } = {},
): Promise<UTxO> {
  for (let i = 0; i < tries; i++) {
    const utxos = await lucid.utxosAt(address);
    const found = utxos.find((u) =>
      u.txHash === txHash && (unit === undefined || (u.assets[unit] ?? 0n) > 0n)
    );
    if (found) return found;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `No output of ${txHash} appeared at ${address} after ` +
      `${(tries * delayMs) / 1000}s. The transaction confirmed, so this is an ` +
      `indexing problem rather than a failed transaction -- check a explorer.`,
  );
}

/**
 * The slot of the current chain tip, as the provider sees it.
 *
 * Deliberately not `lucid.currentSlot()`, which converts the *local* clock to
 * a slot number and so cannot tell you anything about the chain. The two are
 * not the same thing, and the difference is what rejects transactions:
 * a node validates a lower validity bound against its tip, and on a sparsely
 * populated testnet the tip can trail wall-clock time by a minute or more.
 * A payout that is legal by the clock is therefore not yet legal by the chain.
 */
export async function chainTipSlot(): Promise<number> {
  const res = await fetch(`${blockfrostUrl()}/blocks/latest`, {
    headers: { project_id: blockfrostProjectId() },
  });
  if (!res.ok) throw new Error(`Blockfrost /blocks/latest returned ${res.status}`);
  const { slot } = await res.json() as { slot: number };
  return slot;
}

/** Block until the chain tip reaches `slot`. Reports progress; blocks are slow. */
export async function awaitTipSlot(
  slot: number,
  { tries = 60, delayMs = 15_000 }: { tries?: number; delayMs?: number } = {},
): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const tip = await chainTipSlot();
    if (tip >= slot) return tip;
    console.log(`  chain tip is slot ${tip}, need ${slot} -- ${slot - tip} slot(s) behind`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Chain tip did not reach slot ${slot} in time.`);
}

/**
 * Wait until the chain agrees a token no longer exists, and report its supply.
 *
 * Asks about the *asset*, not about a wallet. A wallet query answers "does this
 * address still show the token", which right after a burn is answered from a
 * stale index -- during development this reported one token remaining moments
 * after a burn the node had already accepted. Total supply is the honest
 * question, and zero is the honest answer.
 */
export async function awaitBurned(
  unit: string,
  { tries = 12, delayMs = 5_000 }: { tries?: number; delayMs?: number } = {},
): Promise<{ quantity: string; events: number }> {
  let last = { quantity: "?", events: 0 };
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${blockfrostUrl()}/assets/${unit}`, {
      headers: { project_id: blockfrostProjectId() },
    });
    if (res.ok) {
      const a = await res.json() as { quantity: string; mint_or_burn_count: number };
      last = { quantity: a.quantity, events: a.mint_or_burn_count };
      if (a.quantity === "0") return last;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}
