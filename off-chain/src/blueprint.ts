/**
 * Loads the CIP-57 blueprint produced by the on-chain project and applies
 * compile-time parameters to the compiled scripts.
 *
 * Regenerate the blueprint with `make blueprint` in ../on-chain whenever the
 * Haskell changes -- the script hash changes with it, and a stale blueprint
 * means you are building transactions against an address nobody is watching.
 */
import { applyParamsToScript, Data, type Script, validatorToAddress } from "@lucid-evolution/lucid";
// Each of these names is both a type and the runtime schema const.
import { AuctionParams, LotParams } from "./types.ts";
import { network } from "./config.ts";

const BLUEPRINT_PATH = new URL("../../on-chain/plutus.json", import.meta.url);

export const AUCTION_VALIDATOR = "Auction Validator";
export const LOT_MINTING_POLICY = "Lot Minting Policy";

interface BlueprintValidator {
  title: string;
  compiledCode: string;
  hash: string;
}

export interface Blueprint {
  validators: BlueprintValidator[];
}

let cached: Blueprint | undefined;

/**
 * Supply the blueprint directly instead of reading it from disk.
 *
 * The browser has no filesystem, so the web app imports `plutus.json` as a
 * module -- Vite inlines it at build time -- and hands it here before building
 * any transaction. Everything downstream (parameter application, address
 * derivation, script attachment) is then identical to the CLI's, which is the
 * point: both halves must apply the same parameters to the same bytecode or
 * they compute different addresses and neither notices until a transaction
 * fails on-chain.
 */
export function setBlueprint(bp: Blueprint): void {
  cached = bp;
}

export async function loadBlueprint(): Promise<Blueprint> {
  if (cached) return cached;
  if (typeof Deno === "undefined") {
    throw new Error(
      "No blueprint available. In the browser it must be supplied with " +
        "setBlueprint() before any transaction is built.",
    );
  }
  let raw: string;
  try {
    raw = await Deno.readTextFile(BLUEPRINT_PATH);
  } catch {
    throw new Error(
      `Could not read ${BLUEPRINT_PATH.pathname}.\n` +
        `Generate it first:  cd ../on-chain && make blueprint`,
    );
  }
  cached = JSON.parse(raw) as Blueprint;
  return cached;
}

export async function rawValidator(title: string): Promise<BlueprintValidator> {
  const bp = await loadBlueprint();
  const v = bp.validators.find((x) => x.title === title);
  if (!v) {
    const have = bp.validators.map((x) => x.title).join(", ");
    throw new Error(`Blueprint has no validator titled "${title}". Found: ${have}`);
  }
  return v;
}

/** The auction validator with its parameters baked in. */
export async function auctionScript(params: AuctionParams): Promise<Script> {
  const { compiledCode } = await rawValidator(AUCTION_VALIDATOR);
  return {
    type: "PlutusV3",
    // Serialise with the schema, reparse as plain Data: applyParamsToScript
    // takes Data values, and this is the least fragile way across that boundary.
    script: applyParamsToScript(compiledCode, [Data.from<Data>(Data.to(params, AuctionParams))]),
  };
}

/** The lot minting policy with its parameters baked in. */
export async function lotPolicyScript(params: LotParams): Promise<Script> {
  const { compiledCode } = await rawValidator(LOT_MINTING_POLICY);
  return {
    type: "PlutusV3",
    script: applyParamsToScript(compiledCode, [Data.from<Data>(Data.to(params, LotParams))]),
  };
}

/** Where one auction lives. Different params => different address. */
export async function auctionAddress(params: AuctionParams): Promise<string> {
  return validatorToAddress(network, await auctionScript(params));
}
