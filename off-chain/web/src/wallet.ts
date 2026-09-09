/**
 * Wallet connection over CIP-30.
 *
 * CIP-30 is the standard every Cardano browser wallet implements, so nothing
 * here is specific to Eternl: a wallet announces itself by putting an object at
 * `window.cardano.<name>`, and `enable()` asks the user for permission and
 * returns the API this page then uses. Eternl, Lace, Nami, Flint, Typhon and
 * Vespr all satisfy the same interface, which is why the page discovers
 * whatever is installed rather than hard-coding one.
 *
 * The important property: `enable()` grants *read access and the right to ask
 * for a signature*. It does not hand over keys. Every transaction this page
 * builds is sent back to the wallet to be signed, and the user sees it and can
 * refuse. The page cannot spend anything on its own, and neither can the
 * server behind it.
 */

/**
 * The CIP-30 API, as Lucid defines it.
 *
 * Taken from Lucid rather than hand-written: this object is handed straight to
 * `selectWallet.fromAPI`, so if the two descriptions of CIP-30 ever disagree,
 * the disagreement should be a type error here and not a runtime failure in the
 * middle of building a transaction.
 */
export type { WalletApi } from "@lucid-evolution/lucid";
import type { WalletApi } from "@lucid-evolution/lucid";

interface WalletEntry {
  name?: string;
  icon?: string;
  apiVersion?: string;
  enable(): Promise<WalletApi>;
  isEnabled(): Promise<boolean>;
}

/** A wallet the browser can see, keyed by the name it registered under. */
export interface AvailableWallet {
  key: string;
  name: string;
  icon?: string;
}

/** Wallets we name nicely when they turn up. Anything else is listed as-is. */
const KNOWN: Record<string, string> = {
  eternl: "Eternl",
  lace: "Lace",
  nami: "Nami",
  flint: "Flint",
  typhon: "Typhon",
  typhoncip30: "Typhon",
  vespr: "Vespr",
  gerowallet: "GeroWallet",
  nufi: "NuFi",
  yoroi: "Yoroi",
  begin: "Begin",
};

function registry(): Record<string, WalletEntry> {
  return (globalThis as unknown as { cardano?: Record<string, WalletEntry> }).cardano ?? {};
}

/**
 * Which wallets are installed.
 *
 * Extensions inject themselves as the page loads and are not always present on
 * the first tick, which is why the caller polls this for a moment rather than
 * reading it once and concluding nothing is installed.
 */
export function availableWallets(): AvailableWallet[] {
  const cardano = registry();
  return Object.keys(cardano)
    .filter((key) => typeof cardano[key]?.enable === "function")
    .map((key) => ({
      key,
      name: cardano[key]?.name ?? KNOWN[key] ?? key,
      icon: cardano[key]?.icon,
    }))
    // Eternl first: it is the one this project was demonstrated with.
    .sort((a, b) => (a.key === "eternl" ? -1 : b.key === "eternl" ? 1 : a.name.localeCompare(b.name)));
}

export class WalletError extends Error {}

/** Ask a wallet for permission and return its API. */
export async function connect(key: string, expectTestnet: boolean): Promise<WalletApi> {
  const entry = registry()[key];
  if (!entry) throw new WalletError(`${key} is not installed in this browser.`);

  let api: WalletApi;
  try {
    api = await entry.enable();
  } catch (e) {
    // A refusal is the user exercising exactly the control CIP-30 gives them,
    // so it is reported as a normal outcome rather than a failure.
    throw new WalletError(
      `${KNOWN[key] ?? key} did not grant access. ` +
        (e instanceof Error && e.message ? e.message : "The request was dismissed."),
    );
  }

  // Network id: 0 is any testnet, 1 is mainnet. Catching this here turns a
  // baffling "no auction UTxO" into a sentence that says what is wrong.
  const id = await api.getNetworkId();
  const onTestnet = id === 0;
  if (expectTestnet !== onTestnet) {
    throw new WalletError(
      `Wrong network. This app is on ${expectTestnet ? "a testnet (Preview)" : "mainnet"}, ` +
        `but your wallet is on ${onTestnet ? "a testnet" : "mainnet"}. ` +
        `Switch networks in the wallet and reconnect.`,
    );
  }
  return api;
}
