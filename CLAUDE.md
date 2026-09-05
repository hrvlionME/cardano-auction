# diplomski — Cardano auction (master's thesis)

On-chain English auction. `on-chain/` is Haskell (Plinth), `off-chain/` is
TypeScript on Deno. See the READMEs in each for detail; this file is the
working context, and `DEMO.md` is the runbook for showing it working.

## Working agreements

- **Never run `git commit`, `git push`, or history rewrites.** Hrvoje commits
  his own work. Stage or leave changes and say what is ready. He also commits
  between sessions, so run `git log` before assuming where HEAD is.
- No `Co-Authored-By: Claude` trailers, and no authorship notes in responses or
  code comments.
- He is a Haskell beginner and has to defend every line at his defence. Prefer
  smaller steps and explain what things do. Offer once to let him write
  on-chain logic himself; if he says write it, write it and explain it well.
- `sudo` needs a password here — hand him those commands to run with `!`.

## Plan

Deadline extended, but thesis *writing* starts the week of 2026-09-01, with a
skeleton owed to his professor. Priority is therefore work that produces
something writable. The contribution is the on-chain half, which is done; the
app is a demonstration vehicle and its scope can be cut. A thin end-to-end CLI
demo (mint, open, bid, payout, claim) demonstrates everything the contracts do
without any frontend.

## State as of 2026-08-30

**The full lifecycle runs end to end on Preview.** All five transaction types
are implemented and have been executed against the real network, and every
branch of both scripts has now been exercised on-chain.

Done:
- Auction validator: `NewBid` / `Payout`, hardened against double satisfaction
  by anchoring every obligation to its own input's `TxOutRef`
- Lot minting policy: one-shot mint, plus a burn branch requiring the seller's
  signature (burn = the winner claiming the item)
- 22 Haskell tests, all passing
- Off-chain: all five transactions, plus a MariaDB indexer and a read-only HTTP API

Three full runs were completed, all settling to a burned token
(`quantity 0, mint_or_burn_count 2` per Blockfrost):

    TESTLOT   1f5c4baf…  no-bid path: Payout with Nothing returns the lot,
                         then a single-signature burn (seller is the holder)
    TESTLOT2  5e889b6a…  four bids, two bidders displacing each other,
                         Payout with Just, then a two-signature burn.
                         This run exposed the PubKeyHash defect below.
    TESTLOT3  660cf932…  the same two-bidder scenario after the fix: the
                         cross-party refund landed in bidder 1\'s real wallet,
                         their enterprise address stayed empty, and the burn
                         needed no sweep step

The auction validator hash moved with the datum change, to
`1a1e968813d2b07b6a5947e39e721d5d3ea961c4050a727c621bcd7e`. The lot policy is
untouched (`ffeecefb…`), so lots minted before the change still verify.
`state/archive/` holds two settled auctions recorded in the old datum format;
they are history, and `deserialiseParams` cannot read them.

`LAPTOP` (`ae7a1d01…`) is deliberately untouched and still in the seller's
wallet — kept clean so the thesis demo and its screenshots are not polluted by
debugging. Break things on a fresh throwaway lot instead.

Wallets, all throwaway, all seeds in `off-chain/.env` (gitignored):

    seller / operator   WALLET_SEED_PHRASE     ~9611 test ADA
    bidder 1            BIDDER1_SEED_PHRASE    ~195 test ADA
    bidder 2            BIDDER2_SEED_PHRASE    ~188 test ADA

The bidders were funded from the seller wallet, not the faucet — that is much
faster and needs no captcha. `bidderIndices()` in `src/config.ts` discovers
however many `BIDDER<n>_SEED_PHRASE` exist, so adding a third is just a
`.env` line.

Next, in order:
1. Thesis writing — the priority, and there is more than enough working to
   write the whole implementation chapter.
2. Frontend, if time survives. Cuttable: the CLI plus `deno task serve`
   already demonstrate everything the contracts do.

If a frontend does happen, that is the moment to split the repo further, and
the boundary should be drawn around the *shared* code rather than around the
indexer: `core/` (types, blueprint, config — the definitions both halves must
agree on), `cli/`, `server/`, `web/`. Splitting earlier buys nothing and risks
schema drift, which is the most dangerous failure mode here because it fails
silently on-chain rather than at build time.

## Gotchas that cost real time — do not rediscover these

- **`.complete({ localUPLCEval: false })` is required.** Lucid's bundled
  evaluator is older than plutus-tx 1.67 and dies decoding the `ScriptContext`
  with `attempted to case a non-const Value`, before any validator logic runs.
  That flag evaluates on the node via Blockfrost instead. Every script
  transaction needs it.
- **The blueprint must contain *unapplied* scripts.** `GenBlueprint.hs` emits
  `auctionValidatorCompiled` / `lotPolicyCompiled`, never the pre-applied
  versions. Publishing an applied script means off-chain applies parameters a
  second time and evaluation fails.
- **Untyped wrappers take parameters as `BuiltinData`** and decode them, so
  off-chain `applyParamsToScript` (which applies `Data`) agrees with the
  script. `liftCode` on a typed value uses Plutus Core's native representation
  and will not match.
- **Refund, seller-payout and lot-delivery outputs must carry the spent
  auction UTxO's `TxOutRef` as an inline datum** — `settlementTag()` in
  `off-chain/src/types.ts`. Without it the validator will not credit the
  output and honest transactions are rejected. This is the double-satisfaction
  defence working as designed.
- `on-chain/plutus.json` is committed on purpose: it is the interface between
  the two halves and rebuilding it compiles the whole Plutus stack.
- **A payout must wait for the chain *tip*, not the wall clock.** The node
  validates a lower validity bound against its tip, and on Preview the tip can
  trail real time by a minute or more between blocks. A payout that is legal by
  the clock is rejected with `OutsideValidityIntervalUTxO` until the chain
  agrees. `lucid.currentSlot()` does not help — it converts the *local* clock
  to a slot number and knows nothing about the chain. Use `chainTipSlot()` /
  `awaitTipSlot()` in `src/lucid.ts`, which read Blockfrost `/blocks/latest`.
- **`validFrom` needs a slot of slack; `validTo` must not have it.** Both floor
  a millisecond timestamp to a slot, and the ledger reports that slot's time.
  For `payout` (`from apEndTime`) flooring lands *before* the deadline and
  fails, so it needs `apEndTime + 1000ms`. For `bid` (`to apEndTime`) flooring
  already lands before the deadline and is correct — and the very slack payout
  requires would break it. Same rounding, opposite consequences.
- **`txInfoSignatories` comes from the required-signers field, not from who
  signed.** A transaction the seller genuinely signed, without `addSignerKey`
  declaring them, shows the burn policy an empty list and fails. `addSignerKey`
  in `claim.ts` is load-bearing.
- **`lucid.utxoByUnit()` cannot be trusted for read-back.** It returned a stale
  UTxO right after a confirmation and `undefined` for a token at a script
  address. Use `awaitUtxo()` in `src/lucid.ts`, which polls an address for an
  expected transaction hash. Blockfrost's per-address index trails `awaitTx` by
  a few seconds, so *any* read straight after confirmation can be stale.
- **A `PubKeyHash` cannot name an address — fixed 2026-08-30, do not undo it.**
  `Bid.bAddress` and `AuctionParams.apSeller` are `Address`, not `PubKeyHash`,
  and the validator compares whole addresses instead of using `toPubKeyHash`.
  The reason: a key hash is the payment credential only, so whoever settles an
  auction can reconstruct at best an *enterprise* address — the same key with
  the staking half missing. The validator accepted such an output and the money
  was genuinely the recipient's, but their wallet watches only its base address
  and showed nothing. Before the fix, bidder 1 accumulated 18 test ADA of their
  own money sitting invisible, and the winner could not burn the lot: it landed
  at an enterprise address holding 2 ADA while 190 ADA sat at their base
  address, and a wallet spends from one address at a time.
  The rule to keep: **a `PubKeyHash` says who may authorise; an `Address` says
  where value is delivered.** `LotMintingPolicy.lpSeller` is still a
  `PubKeyHash` and should stay one — it is checked against `txInfoSignatories`,
  and signatures are made by keys, not addresses.
- **`utxoByUnit` is not the only stale read.** Any wallet or address query made
  straight after `awaitTx` may be answered from an index that has not caught
  up: `open-auction` once refused a freshly minted lot as "not in your wallet",
  and `claim` reported a token still outstanding moments after a burn the node
  had already accepted. Use `awaitUtxo` for outputs and `awaitBurned` for
  supply — the latter asks about the *asset*, which is the one question a
  per-address index cannot answer stalely.

## Commands

    cd on-chain  && make test         # 22 tests
    cd on-chain  && make blueprint    # regenerate plutus.json after ANY change
    cd off-chain && deno task check   # type-check
    cd off-chain && deno task smoke   # offline: encodings + params, no keys
    cd off-chain && deno task info    # wallet balance and tokens
    cd off-chain && deno task verify-lot   # minted NFTs still match the code

The lifecycle, in order. Each takes a minute or two to confirm:

    deno task mint-lot LAPTOP        # mint the lot NFT
    deno task open-auction 5 20      # 5 ADA reserve, closes in 20 minutes
    deno task bid 7 --as 1           # bidder 1 bids 7 ADA
    deno task bid 9 --as 2           # bidder 2 outbids, refunding bidder 1
    deno task payout                 # after the deadline; waits for the tip
    deno task claim                  # holder + seller co-sign, burn the token

    deno task sync                   # replay auctions from the chain into MariaDB
    deno task serve --sync           # read-only HTTP API on :8000
    deno task db:reset               # drop every table and rebuild from chain

Each takes an optional trailing id — any prefix of the policy id — to pick
between lots when more than one is on disk. Errors print as plain messages;
`DEBUG=1` restores the stack trace.

After changing anything in `on-chain/`, run `make blueprint` then
`deno task verify-lot`. Script hashes move when the Haskell moves, and a stale
blueprint means building transactions against an address nobody is watching.

## The indexer

`off-chain/src/indexer/` — MariaDB via `npm:mysql2`, plus a read-only HTTP API.
It lives inside `off-chain/` on purpose: it must decode datums with the *same*
schemas the transaction builders encode with, and derive addresses through the
*same* parameter application. Duplicating those would guarantee drift.

One-time setup (the server is not enabled at boot on this machine):

    sudo systemctl start mariadb
    sudo mariadb < off-chain/sql/setup.sql

That creates database `auction_indexer` and user `auction`. Credentials live in
`off-chain/.env` as `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` /
`DB_NAME`, all with working defaults. `openDb()` fails with those two commands
printed rather than a driver stack trace, so a dead server is self-explaining.

**It was SQLite until 2026-09-05.** The swap is worth a paragraph in the thesis
because the reasoning is the interesting part, not the SQL: an embedded store is
a file owned by one process, which fits a single CLI indexer and does not fit an
indexer writing while an API server and a browser read. Nothing about the
*design* changed — the schema, the shape-based classification and the idempotent
sync are identical. What changed is that readers get a connection instead of
needing to share a filesystem. Dialect deltas were small (`AUTOINCREMENT` →
`AUTO_INCREMENT`, `ON CONFLICT` → `ON DUPLICATE KEY UPDATE`, `INSERT OR IGNORE`
→ `INSERT IGNORE`, `CHECK` → `ENUM`, and `TEXT` keys needing explicit widths);
the real cost was that MariaDB drivers are async, so `await` propagates through
`sync.ts`, `api.ts` and both entry scripts.

Two properties to preserve:

- **The database is derived, never authoritative.** `deno task db:reset` drops
  every table, recreates them and re-syncs; it rebuilds from the chain. Sync is
  idempotent via a `UNIQUE (policy_id, tx_hash)` key, so it is safe to
  interrupt. The reset command prints what it dropped and what came back so the
  two can be compared out loud — a conventional auction site cannot survive the
  same demonstration, because there the bids only ever existed in the database.
- **The API holds no keys and signs nothing.** It can lag, crash or lie and no
  bidder loses money; the worst case is misleading someone about an auction's
  state. Bidding goes through a wallet, not through the server.

Events are classified by transaction *shape* rather than by redeemer — an
output at the address with no input from it is an open, an input with an output
back is a bid, an input with no output back is a settle — which is enough to
reconstruct the whole history.

**The limitation:** compile-time parameters mean every auction is a different
script at a different address, so there is no contract to watch. The indexer
can only learn about auctions it is told about (currently from
`state/auction-*.json`). An auction opened by a stranger is invisible to it
forever. This is the practical argument for the first open question below.

## Open design questions for the thesis

- Parameters are compile-time, so every auction is its own script and address.
  Clean, but a reference script per auction does not scale. Moving parameters
  into the datum gives one shared script at the cost of validating untrusted
  parameters and putting all auctions at one address.
- **`Bid` stores a `PubKeyHash`, which cannot reconstruct an address.** This is
  the sharpest of these, and the two-bidder run demonstrated it rather than
  merely predicting it — see the gotcha above. Storing an `Address` in the datum
  fixes it, at the cost of a larger datum and of having to validate a structure
  the bidder supplied rather than one the chain derived.
- Nobody is paid to submit `Payout`, and the submitter funds the winner's
  min-ADA out of pocket. Confirmed by the balances: across a four-bid auction
  the seller was down 5 test ADA net of the winning bid, having fronted min-ADA
  twice — once at open, once for the winner's delivery. The 2 ADA fronted at
  open is pocketed by the *first bidder* as change, since `correctOutput`
  requires the continuing output to hold exactly the bid.
- `correctOutput` does not forbid extra tokens in the continuing output, so a
  UTxO can be bloated with junk.
- Seller is the app operator, so users trust the operator for delivery. The
  chain guarantees the money, never the laptop.
