# diplomski — Cardano auction (master's thesis)

On-chain English auction. `on-chain/` is Haskell (Plinth), `off-chain/` is
TypeScript on Deno. See the READMEs in each for detail; this file is the
working context.

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
- 19 Haskell tests, all passing
- Off-chain: all five transactions, plus `sweep` (see the address gotcha below)

Two full runs were completed, both settling to a burned token
(`quantity 0, mint_or_burn_count 2` per Blockfrost):

    TESTLOT   1f5c4baf…  no-bid path: Payout with Nothing returns the lot,
                         then a single-signature burn (seller is the holder)
    TESTLOT2  5e889b6a…  four bids, two bidders displacing each other,
                         Payout with Just, then a two-signature burn

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
1. Thesis writing — this is the priority now, and there is enough working to
   write the whole implementation chapter.
2. Decide the `Bid` datum question below. It is a real defect with a real fix
   and it is good thesis material either way.
3. Indexer + DB + HTTP API, then frontend. Cuttable: the CLI already
   demonstrates everything the contracts do.

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
- **Refunds and payouts land at enterprise addresses, and wallets do not watch
  them.** `Bid` stores only a `PubKeyHash`, so whoever settles knows the
  recipient's payment key and not their staking credential — the best address
  it can build is an enterprise one. The validator accepts it (`toPubKeyHash`
  ignores the staking part) and the money is genuinely theirs, but their
  everyday wallet looks only at its base address and sees nothing. In the
  two-bidder run, bidder 1 accumulated 18 test ADA of their own money sitting
  invisible. `deno task sweep` is the off-chain repair; the real fix is on-chain
  and is listed as an open question below.

## Commands

    cd on-chain  && make test         # 19 tests
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
    deno task sweep                  # recover funds at enterprise addresses
    deno task claim                  # holder + seller co-sign, burn the token

Each takes an optional trailing id — any prefix of the policy id — to pick
between lots when more than one is on disk. Errors print as plain messages;
`DEBUG=1` restores the stack trace.

After changing anything in `on-chain/`, run `make blueprint` then
`deno task verify-lot`. Script hashes move when the Haskell moves, and a stale
blueprint means building transactions against an address nobody is watching.

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
