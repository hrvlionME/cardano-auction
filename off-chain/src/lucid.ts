/** Lucid instance construction. */
import { Blockfrost, Lucid } from "@lucid-evolution/lucid";
import { blockfrostProjectId, blockfrostUrl, network, walletSeedPhrase } from "./config.ts";

/** Derived rather than imported by name, so a rename upstream cannot silently rot. */
export type Lucid = Awaited<ReturnType<typeof Lucid>>;

/** Read-only: can query the chain, cannot sign. */
export function makeLucid(): Promise<Lucid> {
  return Lucid(new Blockfrost(blockfrostUrl(), blockfrostProjectId()), network);
}

/** Signing-capable, using the seed phrase from .env. */
export async function makeWalletLucid(): Promise<Lucid> {
  const lucid = await makeLucid();
  lucid.selectWallet.fromSeed(walletSeedPhrase());
  return lucid;
}
