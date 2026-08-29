# off-chain

Transaction building for the auction, in TypeScript on Deno, using
[Lucid Evolution](https://anastasia-labs.github.io/lucid-evolution/).

The on-chain scripts only ever answer yes or no. Everything that actually
happens -- selecting UTxOs, constructing outputs, attaching datums, setting
validity ranges, computing fees and script budgets, signing, submitting -- is
built here.

## Setup

    cp .env.example .env
    deno task wallet          # generate a testnet wallet, paste the seed into .env

Get a free Blockfrost key at https://blockfrost.io (project must be on the same
network as `CARDANO_NETWORK`), then fund the address from the
[faucet](https://docs.cardano.org/cardano-testnets/tools/faucet).

## Tasks

    deno task check     # type-check
    deno task smoke     # offline sanity check: no network or keys needed
    deno task wallet    # generate a testnet wallet

`deno task smoke` is the one to run after any change to the Haskell. It
verifies the blueprint loads, both scripts take their parameters, and the
Plutus data encodings still match the on-chain types.

## Layout

| Path | What |
|---|---|
| `src/config.ts` | environment and network settings |
| `src/lucid.ts` | Lucid instance, with and without a wallet |
| `src/types.ts` | Plutus data schemas mirroring the Haskell types |
| `src/blueprint.ts` | loads `plutus.json`, applies params, derives addresses |
| `src/tx/` | one module per transaction |
| `scripts/smoke.ts` | offline wiring check |
| `scripts/gen-wallet.ts` | testnet wallet generator |

## Keeping in step with the on-chain side

`src/types.ts` and `../on-chain/src/*.hs` describe the same data from two
sides. Nothing checks them against each other at build time -- a mismatch
surfaces on-chain as an opaque parse failure, after submission. When you change
a Haskell type, change the schema here, regenerate the blueprint with
`make blueprint` in `../on-chain`, and run `deno task smoke`.
