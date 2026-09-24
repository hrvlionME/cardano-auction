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

Checks, all offline:

    deno task check       # type-check
    deno task smoke       # blueprint loads, params apply, encodings match Haskell
    deno task verify-lot  # minted lots still match the current code
    deno task web:check   # type-check the browser code

`deno task smoke` is the one to run after any change to the Haskell. It
verifies the blueprint loads, both scripts take their parameters, and the
Plutus data encodings still match the on-chain types.

Wallets:

    deno task wallet      # generate a testnet wallet
    deno task info        # balances, tokens and live auctions, parties named

The lifecycle, in order. Each takes a minute or two to confirm, and each takes
an optional trailing policy-id prefix to pick a lot:

    deno task mint-lot LAPTOP        # mint the lot NFT
    deno task open-auction 5 20      # 5 ADA reserve, closes in 20 minutes
    deno task bid 7 --as 1           # bidder 1 bids 7 ADA
    deno task bid 9 --as 2           # bidder 2 outbids, refunding bidder 1
    deno task payout                 # after the deadline; waits for the tip
    deno task claim                  # holder + seller co-sign, burn the token

Indexer, API and web app (needs MariaDB, see `sql/setup.sql`, or Docker, see
the root README):

    deno task sync            # replay known auctions from the chain into MariaDB
    deno task db:reset        # drop the indexer tables and rebuild from chain
    deno task serve --sync    # API, chain proxy and web/dist on :8000
    deno task web:build       # bundle the web app into web/dist
    deno task web             # Vite dev server on :5173, proxying to :8000

## Layout

| Path | What |
|---|---|
| `src/config.ts` | environment and network settings, for both Deno and the browser |
| `src/lucid.ts` | Lucid instance, plus the chain-tip and stale-read helpers |
| `src/types.ts` | Plutus data schemas mirroring the Haskell types |
| `src/blueprint.ts` | loads `plutus.json`, applies params, derives addresses |
| `src/state.ts` | reads and writes `state/lot-*.json` and `state/auction-*.json` |
| `src/cli.ts` | plain-message errors for the scripts (`DEBUG=1` for stack traces) |
| `src/tx/` | one module per transaction, shared by the CLI and the browser |
| `src/indexer/` | MariaDB read model, sync from the chain, read API, Blockfrost proxy |
| `src/app/` | accounts (sign-in by wallet signature), listings, image uploads |
| `scripts/` | one entry point per `deno task` |
| `web/` | React + Vite web app; imports `src/` through the `@core` alias |
| `sql/setup.sql` | one-time MariaDB database and user |
| `state/` | lots and auctions opened from the CLI (gitignored) |
| `uploads/` | listing photographs, named by content hash (gitignored) |

## Keeping in step with the on-chain side

`src/types.ts` and `../on-chain/src/*.hs` describe the same data from two
sides. Nothing checks them against each other at build time -- a mismatch
surfaces on-chain as an opaque parse failure, after submission. When you change
a Haskell type, change the schema here, regenerate the blueprint with
`make blueprint` in `../on-chain`, and run `deno task smoke`.
