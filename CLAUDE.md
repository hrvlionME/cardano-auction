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

Next: **thesis writing.** Everything the implementation chapter needs is built
and evidenced on-chain. A template exists as of 2026-09-05.

The frontend was built on 2026-09-05 — see "The web app" below. It exists
because the demonstration has to be legible to a non-technical mentor, and
possibly shown publicly later; the CLI and the API were already sufficient as
*proof*, but not as *presentation*.

The repo was **not** split into `core/` / `cli/` / `server/` / `web/`, though
earlier notes here anticipated it. It turned out unnecessary: `web/` imports the
shared modules directly through a Vite alias, so there is one copy of the
schemas and one parameter application, which is the property the split was for.
A split would move the same files behind package boundaries and buy nothing that
the alias does not already give. Revisit it only if a second consumer appears
that cannot reach into `off-chain/src/`.

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
    deno task web                    # Vite dev server on :5173 (needs serve running)
    deno task web:build              # bundle into web/dist, which `serve` then hosts
    deno task web:check              # type-check the browser code
                                     # accounts live at /auth/* and /me/*

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

## The web app

`off-chain/web/` — React 18 + Vite 6 + TypeScript, driven by **Deno, not npm**
(`deno run -A npm:vite`). npm is not installed on this machine and installing it
would mean a second toolchain and a `sudo`; Deno already resolves npm packages,
so `deno task web` and `deno task web:build` are the whole story.

Two ways to run it:

    deno task serve --sync        # API + chain proxy + web/dist, one port
    deno task web                 # Vite dev server on :5173 with hot reload,
                                  # proxying /auctions and /chain to :8000

The second still needs `deno task serve` running alongside it.

**The browser builds its bid with the CLI's own code.** `web/src/chain.ts`
imports `bid()` from `src/tx/bid.ts` and the schemas from `src/types.ts`
unchanged, via a Vite alias (`@core` → `off-chain/src`). Only two things
differ: the wallet is a CIP-30 extension rather than a seed phrase, and the
provider is our own `/chain` proxy rather than Blockfrost directly. This is the
point of not splitting the repo — a second transaction builder in a second
runtime is exactly where a datum schema silently diverges by one constructor
tag, and that failure surfaces on-chain after a fee has been paid, not at build
time.

Three things had to change in the shared code to make it importable by a
browser, all small and all worth keeping:

- `config.ts` reads env through one `envVar()` helper that checks for `Deno`
  before touching it, and falls back to Vite's `import.meta.env` with a `VITE_`
  prefix. A bare `Deno.env.get` at module scope crashes the bundle on load.
- `blueprint.ts` gained `setBlueprint()`. The browser has no filesystem, so the
  web app imports `plutus.json` as a module and hands it over at startup.
  **A stale bundle carries a stale script hash** — rebuild the web app after
  `make blueprint`, just as you re-run `deno task verify-lot`.
- `web/src/deno-shim.d.ts` declares the handful of Deno globals the shared
  modules use, so `tsc` can check browser code that imports them.

**CIP-30 is a standard, so nothing is Eternl-specific.** The page lists
whatever wallets injected themselves into `window.cardano` and sorts Eternl
first. Lace, Nami, Flint, Typhon and Vespr satisfy the same interface. Wallets
inject asynchronously, so `useWallet` polls briefly rather than reading once and
concluding nothing is installed. `connect()` also compares
`getNetworkId()` against the configured network, which turns a baffling "no
auction UTxO" into a sentence naming the real problem.

**The Blockfrost project id never reaches the browser.**
`src/indexer/chain-proxy.ts` forwards `/chain/*` to Blockfrost, adding the
`project_id` header server-side. This does not weaken the claim that the server
cannot move money: a project id is a read-and-relay credential, and everything
crossing the proxy toward the chain was signed in the user's wallet moments
earlier. The proxy is a postbox, not an authority. Exposed to the internet it
would want a path allowlist and its own rate limit; on localhost it does not.

The web app covers **bid, settle and burn**, not just bidding:

- **Settle** appears once bidding is over and anyone may press it. This is the
  concrete face of "a blockchain has no scheduler": a validator is a predicate
  that runs only when someone tries to spend the UTxO, so a finished auction
  sits there, correct and unsettled, until a transaction arrives. The contract
  guarantees *safety* (if it happens it is right), never *liveness* (that it
  happens). A button costs nothing in trust, because whoever clicks it still
  cannot make the transaction do anything the validator would reject. Contrast
  a keeper bot, which would have to hold a key on the server and would break
  the claim that the server can move no funds.
- **Claim (burn)** is offered only when the connected wallet is both holder and
  seller, because the burn needs both signatures on one transaction. When it is
  two people the interface says so plainly and points at the CLI. That boundary
  is a finding worth writing up: the contract is one click when one party, and
  needs a protocol when two.

Both reuse the CLI's `payout()` and `claim()` unchanged. Two shared pieces had
to become runtime-neutral for that: `chainApiBase()` in `config.ts` (the CLI
reads Blockfrost directly, the browser goes through `/chain`), and the minting
policy's parameters, which live in `state/lot-*.json` and are now recorded on
the `auctions` table so a browser can rebuild the policy without reading this
machine's disk. That was the project's only schema migration, done with
MariaDB's `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

Build gotchas, both already resolved:

- Lucid ships three WASM blobs, so Vite needs `vite-plugin-wasm`. The usual
  companion `vite-plugin-top-level-await` is **not** used: it is incompatible
  with the resolved `@swc/core` ("missing field `type`") and is unnecessary at
  `target: "esnext"`, where top-level await is native. Lowering the target
  brings the problem back.
- `serve.ts` must send `.wasm` as `application/wasm`.
  `WebAssembly.instantiateStreaming` refuses anything else, and the failure
  looks like broken signing rather than a MIME problem.
- **Lucid needs Node globals polyfilled, and says so badly.** Its dependency
  tree (safe-buffer, readable-stream) reaches for `Buffer`, `process` and
  `global` without importing them. The first symptom is
  `Cannot read properties of undefined (reading 'from')` thrown from inside a
  pre-bundled Lucid, which names nothing useful -- it is `safe-buffer` doing
  `require("buffer")` and getting the externalised built-in, i.e. `undefined`.
  Fixing that yields `process is not defined` next. Both are handled by
  `web/src/polyfills.ts`, imported *first* in `main.tsx` because ES modules
  evaluate depth-first in import order, plus a `buffer` alias in
  `vite.config.ts` that must be an **absolute** path (a bare specifier is
  re-resolved by the same alias and Vite refuses it).
  This bites in `deno task web` and not always in `web:build`, so a working
  production bundle is not evidence the dev server works. Test both.

Verified by rendering **both** the dev server (:5173) and the built page
(:8000) in headless Chromium: React mounts, the API is fetched, TESTLOT3
renders with its bid history, and the console is clean in each.
Signing itself needs a real wallet extension and has not been exercised
head-lessly.

## Accounts and sign-in by wallet (built 2026-09-06)

`off-chain/src/app/` — accounts, profiles and verifiable history, on top of the
same MariaDB the indexer uses. Endpoints are served by `deno task serve`
alongside the read model.

**The rule that decides where anything goes.** Ask: *if this row were deleted,
forged, or edited by the operator, could anyone lose money?* Yes → on-chain.
No → an ordinary table, and better there. Editing a product photo is a lie the
operator's reputation pays for; editing a bid is theft. Only the second needs a
ledger, and that sentence is the thesis argument in miniature.

**Authentication is a wallet signature, not a password.** CIP-30 `signData`
against a server-issued nonce:

    POST /auth/nonce   {address}                        -> {nonce, payloadHex}
    POST /auth/login   {address, nonce, signature, key} -> session cookie
    GET  /auth/me                                       -> user + addresses
    POST /auth/logout
    PUT  /auth/profile {displayName, email, ...}
    GET  /me/history                                    -> bids, from the chain

Verification is `verifyData` from Lucid, which the CLI can produce signatures
for identically — so a browser signature and a seed-phrase signature are
indistinguishable to the server.

Three things that must not be relaxed:

- **The signed message is rebuilt server-side, never taken from the request.**
  Verifying a client-supplied payload proves only that the client signed
  *something*. It has to be our nonce, for that address.
- **The nonce is single-use and expires** (5 min). `consumeNonce` does the check
  and the mark-used in one `UPDATE ... WHERE used_at IS NULL`, so two
  simultaneous attempts cannot both win. A SELECT-then-UPDATE would leave that
  race open.
- **The session cookie is HttpOnly / SameSite=Lax, with no `Secure`** because
  the demo is http on localhost. Anything deployed publicly must add `Secure`
  and be behind TLS.

**An account is optional.** Connecting a wallet is enough to bid — bidding is a
transaction the chain validates and the server is never consulted. Refusing the
sign-in signature leaves everything working. The account only adds what the
chain deliberately does not know.

**History is a join, not a table.** `historyFor` joins `events` (derived from
the chain) against `wallet_addresses`. Nothing about bids is stored twice. The
consequence worth stating: a user's history here is *verifiable* against a
public explorer, where on a conventional site it is whatever the operator's
database says.

**`wallet_addresses` is many-to-one on purpose.** A wallet holds several
addresses — the base/enterprise distinction that caused the `PubKeyHash` defect
— and each is proved by its own signature.

**KYC never touches the chain.** A ledger is permanent, public and unfixable;
personal data has to live where it can be corrected, access-controlled and
*erased*. That is what makes a right-to-erasure request answerable, and it is
the reason the split falls where it does — not a workaround.

**Careful: `src/app/` tables are authoritative, not derived.** `deno task
db:reset` rebuilds the indexer from the chain; accounts cannot be rebuilt from
anything. It is safe because `dropAll()` only drops the three names in the
indexer's own `TABLES`, so that list is now load-bearing. A second database
would make the boundary structural rather than a convention.

Verified end to end against real wallets: sign-in, replayed nonce rejected,
signature from the wrong wallet rejected, session, profile update with
validation, history, sign-out, and a second sign-in reusing the same account.

### Still TODO — product metadata

The remaining gap is that a lot is just a token name, which is why listings
read as a demo. A `lots` table (`policy_id` PK, title, description, category,
condition, image_url) joined onto `auctions` in the API would render "MacBook
Pro 14-inch, 2023, excellent" with a photo instead of a hex string. The honest
caveat to state alongside it: that metadata is operator-controlled — the chain
guarantees the money, the operator describes the goods, exactly as with
physical delivery.

**Worth one paragraph rather than an implementation:** CIP-25 and CIP-68 put
NFT metadata on-chain in the minting transaction, making the description as
tamper-evident as the ownership. It costs fees per byte, cannot be corrected
after minting, and is unusable for images — which is why real marketplaces do
what is proposed above and pin images to IPFS with only the hash on-chain.
Noticing the trade-off and choosing deliberately is worth more than building it.

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
