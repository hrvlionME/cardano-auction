# diplomski

On-chain English auction for Cardano. Master's thesis project.

Two halves, and the split matters:

| Folder | Language | What it is |
|---|---|---|
| [`on-chain/`](on-chain) | Haskell (Plinth) | the validator and minting policy -- pure predicates that answer yes or no |
| [`off-chain/`](off-chain) | TypeScript (Deno) | everything that actually builds and submits transactions |

A Cardano script cannot do anything on its own. It cannot move funds, read a
clock, or call anyone. It is shown a finished transaction and asked whether it
approves. So the on-chain code defines the *rules*, and the off-chain code
constructs transactions that satisfy them.

## The interface between them

`on-chain` compiles to `on-chain/plutus.json`, a CIP-57 blueprint holding both
compiled scripts. `off-chain` reads that file, applies compile-time parameters,
and derives the script addresses.

The blueprint is committed, because building it from source compiles the whole
Plutus stack and takes a long time. Regenerate it with `make blueprint` in
`on-chain` whenever the Haskell changes -- a stale blueprint means building
transactions against an address nobody is watching.

## Quick start

    cd on-chain  && make test       # 19 tests
    cd off-chain && deno task smoke # offline wiring check

See each folder's README for detail.
