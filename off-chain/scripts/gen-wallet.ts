/**
 * Generates a fresh testnet wallet and prints the seed phrase and address.
 *
 * Put the seed phrase in .env as WALLET_SEED_PHRASE, then fund the address
 * from the faucet: https://docs.cardano.org/cardano-testnets/tools/faucet
 *
 * Testnet only. Do not reuse this key for anything holding real value.
 */
import { generateSeedPhrase, walletFromSeed } from "@lucid-evolution/lucid";
import { network } from "../src/config.ts";

const seed = generateSeedPhrase();
const wallet = walletFromSeed(seed, { network });

console.log(`\nnetwork:  ${network}`);
console.log(`\nseed phrase (put in .env as WALLET_SEED_PHRASE):\n\n  ${seed}\n`);
console.log(`address:\n\n  ${wallet.address}\n`);
console.log("fund it at https://docs.cardano.org/cardano-testnets/tools/faucet\n");
