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

## State as of 2026-08-29

Working end to end. A lot NFT is minted and confirmed on **Preview**:

    policy id  ae7a1d010be736209948e0fee6af36324027f995287f44ff07a70225
    tx         c2ae97ebd370d9a29f3c2fe9d8627da9c658bb3d78a6973bc15689546ba0e5b5
    wallet     ~9999.7 test ADA, throwaway, seed in off-chain/.env (gitignored)

Done:
- Auction validator: `NewBid` / `Payout`, hardened against double satisfaction
  by anchoring every obligation to its own input's `TxOutRef`
- Lot minting policy: one-shot mint, plus a burn branch requiring the seller's
  signature (burn = the winner claiming the item)
- 19 Haskell tests, all passing
- Off-chain scaffold, blueprint loading, parameter application, `mint-lot`

Next, in order:
1. `off-chain/src/tx/open-auction.ts` — lock the NFT at the auction address
   with datum `Nothing`. Reads `state/lot-*.json`. No script runs on this one:
   paying *to* a script address never executes it.
2. `bid.ts`, `payout.ts`, `claim.ts`
3. Indexer + DB + HTTP API, then frontend

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

## Commands

    cd on-chain  && make test         # 19 tests
    cd on-chain  && make blueprint    # regenerate plutus.json after ANY change
    cd off-chain && deno task check   # type-check
    cd off-chain && deno task smoke   # offline: encodings + params, no keys
    cd off-chain && deno task info    # wallet balance and tokens
    cd off-chain && deno task verify-lot   # minted NFTs still match the code

After changing anything in `on-chain/`, run `make blueprint` then
`deno task verify-lot`. Script hashes move when the Haskell moves, and a stale
blueprint means building transactions against an address nobody is watching.

## Open design questions for the thesis

- Parameters are compile-time, so every auction is its own script and address.
  Clean, but a reference script per auction does not scale. Moving parameters
  into the datum gives one shared script at the cost of validating untrusted
  parameters and putting all auctions at one address.
- Nobody is paid to submit `Payout`, and the submitter funds the winner's
  min-ADA out of pocket.
- `correctOutput` does not forbid extra tokens in the continuing output, so a
  UTxO can be bloated with junk.
- Seller is the app operator, so users trust the operator for delivery. The
  chain guarantees the money, never the laptop.
