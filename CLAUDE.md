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
can only learn about auctions it is told about (from `state/auction-*.json` for
CLI auctions, and `lots.registration` for browser-opened ones). An auction opened by a stranger is invisible to it
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
                       (payload: "Sign in to <SITE_ORIGIN>" + nonce)
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
  *something*. It has to be our nonce, for that address. The same applies to
  the *name* in it: since 2026-09-16 the message reads `Sign in to
  <SITE_ORIGIN>` rather than naming a brand, and `siteOrigin()` reads the
  server's own configuration and never the incoming Host header. Naming the
  site is what stops a signature collected here being replayed as a login
  elsewhere, and that only works if the server decides the name. An origin also
  beats a brand for a second reason: it is the one identifier the user can check
  against their own address bar, where a brand name is a string any page can
  print. Set `SITE_ORIGIN` before putting the app behind a domain.
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

## Listings, selling from the browser, and the UI rebuild (2026-09-16)

The app stopped being a demo harness and became something a mentor can be shown
without narration. Three things landed together.

### Product metadata — done

`lots` table (`policy_id` PK, title, description, category, condition,
image_url, created_by, registration) in **`src/app/lots.ts`**, served at
`/lots`. It is *not* joined into `/auctions`: the two come back as two
responses and the browser merges them, so the boundary between "the chain
guarantees this" and "the operator says this" stays visible in the API surface
instead of blurring into one object.

Images are in **`src/app/uploads.ts`**, on disk under `off-chain/uploads/`,
served at `/uploads/<sha256>.<ext>`. Two properties, both security rather than
tidiness: **content-addressed**, so no uploader ever chooses a filename (no
traversal, no collision, free dedup), and **sniffed, not declared** — the type
comes from the leading bytes, because serving a file as whatever it claims to
be is how an "image" upload becomes stored XSS. SVG is refused: it is script.

Who may edit is not an operator decision. There is no seller role and no owner
column: `ownsAddress()` asks whether the account has proved control of the
address the compiled script will pay. **The right to describe the goods follows
from a fact on the chain.**

The caveat to state in the thesis is unchanged and should be stated plainly:
this metadata is operator-controlled. CIP-25/CIP-68 would put it in the minting
transaction and make it as tamper-evident as the ownership, at the cost of fees
per byte, no corrections ever, and no images. Real marketplaces do what this
does and pin images elsewhere. Choosing deliberately is the contribution.

### Selling from the browser — done

`web/src/pages/Sell.tsx`. **Two transactions, and they have to be two:** the
auction validator is parameterised by the lot's CurrencySymbol, which *is* the
minting policy's hash, which depends on the seed UTxO the mint consumes — so
there is no auction address to compute until the token exists. The wizard shows
that rather than hiding it behind one spinner.

Both transactions are `mintLot()` and `openAuction()` from `src/tx/`,
**unchanged**. The only differences from the CLI are the wallet (CIP-30 rather
than a seed phrase) and the provider (`/chain` rather than Blockfrost).

New shared helper: **`awaitWalletAsset()` in `src/lucid.ts`.** The stale-read
gotcha below is invisible on the CLI, where minting and opening are two
commands run minutes apart, and bites *every time* in a browser that does both
back to back — `openAuction` refuses a lot that demonstrably exists. Waits for
the wallet to agree it holds the token.

Step three is `POST /lots`, and it is the interesting one. **Nothing submitted
is believed:** `registerListing` recomputes the minting policy from its
parameters and checks the policy id, recomputes the script address from its
parameters and checks it matches, checks the caller proved control of the
seller address, and then asks the chain whether the opening transaction really
put that token there. A client that lies fails all four. If step three fails
the auction is still open and correct on-chain and only missing from the index
— which is exactly what the error message says.

### Two changes to the indexer, both forced

- `syncAll` now syncs **every row in `auctions`**, not only what
  `registerKnownAuctions` just read off disk. Without it a browser-created
  auction sits at zero bids forever: correct on the chain, invisible in the UI.
- It also calls `registerStoredListings()`. **`db:reset` drops `auctions`, and
  an auction's compile-time parameters cannot be recovered from the chain** —
  the ledger stores the *hash* of the applied script, not what produced it. So
  a browser-created auction needed somewhere authoritative to live, exactly as
  a CLI one lives in `state/`. That is the `lots.registration` column, replayed
  and re-derived on every sync. `lots` is deliberately absent from the
  indexer's `TABLES` and has no FK to `auctions`, or the reset would cascade
  every title and photograph away.

### The UI

`react-router` and real URLs: `/`, `/auction/:policyId`, `/sell`, `/account`. `App.tsx` went from 620 lines doing everything to a shell plus
`pages/` and small components. Wallet-and-account state moved into one
`session.tsx` context — and the two are kept separate on purpose, because
`conn && !me.user` (connected, able to bid, declining to be known) is the state
worth demonstrating, not an edge case to tolerate.

**There is no sign-in page, and connecting never asks for a signature.** The
first cut had both, and both were wrong. `connectWallet` used to call `signIn`
straight afterwards, which meant two prompts in a row *and* a signature prompt
on every connect even when the browser already held a valid session. Signing
something you have already signed teaches people to click through prompts
without reading them — precisely the habit to avoid when the argument is that
they *can* read what they sign.

So the two actions are kept apart, in a header dropdown (`WalletMenu.tsx`):

- **Connect** grants read access and the right to *ask* for a signature. No
  keys change hands. It is all that bidding, settling and burning need, and
  none of them consult this server.
- **Sign in** is separate, explicit, and optional — one signature, then a
  30-day session (was 7 days; `SESSION_TTL_MS`).

**No wordmark.** The header is the ₳ mark alone — `aria-label="Home"` on the
link, because a screen reader announcing "link, ₳" is not an accessible name.
The tab is titled "Auction". Removing the words is what forced the signed
message onto an origin: there was no longer a name for it to match, and an
origin is the better identifier anyway.

**The footer is pinned to the bottom of the window**, and the fix is worth
remembering because the obvious version does not work. React mounts into
`#root`, so `#root` is `body`'s only child — making `body` a flex column pushes
nothing down, because header, main and footer are *grandchildren* and never
become flex items. The column has to be declared on `#root`. Verified at
1280x900: on the homepage and on a 404 the footer sits at exactly the viewport
height with no scrollbar; on a long auction page it flows past, as it should.

The last-used wallet key goes in `localStorage` (the key only — never an
address or a session), and on load `alreadyEnabled()` asks the extension
whether it still has the origin authorised before calling `enable()`. A wallet
that already trusts the page reconnects with no dialog at all; one that has
revoked access is simply not reconnected, silently, because the user did not
ask for one.

The footer states which properties are decentralized and which are not — same
table as below, in the interface where a user reads it.

### Verified 2026-09-16

Server side, against the real database and real wallets, by signing in from the
CLI — which produces signatures a browser signature is indistinguishable from,
so this exercises the same code path Eternl does:

- seller session issued; listing metadata written and read back
- unknown category rejected (400); unauthenticated write rejected (401)
- **non-seller write rejected (403)** — signed in as bidder 1, refused on an
  auction sold by the seller wallet
- image stored content-addressed, served as `image/png`, cached immutably
- **HTML declared as `image/png` rejected**, because the check reads the bytes
- `/uploads/../../.env` → 404
- registration with invented parameters rejected, naming the currency symbol it
  re-derived versus the one claimed

Rendered in headless Chromium over CDP, **both** the built bundle on :8000 and
the Vite dev server on :5173 — a working production bundle is not evidence the
dev server works, so test both: `/`, `/sell`, `/auction/:policyId` and an
unknown path all mount, fetch, and render; the header wallet dropdown opens and
lists what is installed; a 30-day session cookie is accepted repeatedly with no
further signature; uploaded photographs load;
the built page's console is **clean**. The dev server still logs four
`Module "events"/"util" has been externalized` warnings from Lucid's dependency
tree, which predate this work.

Two console fixes worth keeping: the favicon is an inlined SVG data URI in
`index.html` (the browser asks for `/favicon.ico` unprompted, and that 404 was
the only line in an otherwise clean console), and `BrowserRouter` opts into
`v7_startTransition` and `v7_relativeSplatPath` rather than carrying two
deprecation warnings — the second matters, because `/account/*` is a splat
route with nested tabs.

### Reaching the dev server

This machine is a VirtualBox guest on NAT (`10.0.2.15` via `10.0.2.2`), so the
host reaches it only through port-forward rules. Vite defaults to binding
loopback only, which made :5173 unreachable while :8000 (bound `0.0.0.0` by
`serve.ts`) worked — it looks like a broken app rather than a binding. Fixed
with `host: true` in `vite.config.ts`, matching what the API server already
does. Development only; never deployed.

**The dev server is optional.** `deno task serve` serves the built bundle on
:8000, and `deno task web:build` refreshes it. :5173 only buys hot reload, and
needs its own forward rule.

**Not yet exercised: the sell wizard end to end.** It needs a real wallet
extension to sign, which headless Chromium has none of. The two transactions it
builds are `mintLot()` and `openAuction()` unchanged, both proven on-chain many
times from the CLI; what is unproven is the browser sequencing them back to
back, which is exactly what `awaitWalletAsset()` exists for. **Rehearse it on a
throwaway lot, not on LAPTOP.**

## The title problem — "decentralized" over-claims (raised 2026-09-09)

The thesis title says **decentralized auction platform**. The system is not
decentralized; it is decentralized in the parts that matter most and
centralized in several that also matter. Left unqualified, that is a claim the
work cannot fully support, and an examiner will find it.

| Property | Status | Why |
|---|---|---|
| Custody of funds | decentralized | nobody, operator included, can seize a bid |
| Settlement | decentralized | the validator decides, not the server |
| Verification | decentralized | anyone can index the chain and check the operator |
| Auction rules | decentralized | enforced on-chain |
| Discovery | **centralized** | compile-time params ⇒ the indexer must be *told* about an auction |
| Liveness | **centralized** | nobody is paid to submit `Payout`; in practice the operator does |
| Identity / KYC | **centralized** | deliberately — erasure requires a store that can delete |
| Item description | **centralized** | the operator describes the goods |
| Physical delivery | **centralized** | unavoidable; no ledger observes a courier |
| Chain access | **centralized** | Blockfrost, though replaceable with an own node |

Four of the centralized rows are already open questions below, which is what
makes this content rather than an embarrassment.

**Preferred handling: keep the title, define the term in the introduction.**
Changing an approved title is bureaucratic, and defining terms precisely is a
scholarly virtue rather than a dodge. Something like:

> In this work, *decentralized* refers to the custody and settlement of funds:
> no participant, including the platform operator, can alter the outcome of an
> auction or seize a bid. Discovery, identity and physical delivery remain
> centralized, and Chapter 8 examines each of those boundaries.

The table then becomes a section, and the weakness becomes the chapter.

**Alternative, if the title is still changeable:** *Decentralized settlement of
English auctions on Cardano* keeps the word but attaches it to the property
that genuinely holds.

**The term of art is "trust-minimised".** It is more accurate than
"decentralized" and is not a retreat: it claims that the trust required was
reduced to the minimum this problem allows, which is stronger and more
defensible than a binary. Almost nothing is fully decentralized — Uniswap has a
centralized frontend, OpenSea is a company on a public ledger. Being precise
about *which* properties are decentralized puts this work ahead of most in the
area, not behind it.

**Raise it before the examiner does.** Volunteering the boundary reads as
rigour; having it pointed out reads as an oversight. Same fact, opposite
impression.

## Open design questions for the thesis

- Parameters are compile-time, so every auction is its own script and address.
  Clean, but a reference script per auction does not scale. Moving parameters
  into the datum gives one shared script at the cost of validating untrusted
  parameters and putting all auctions at one address.
- **Resolved 2026-08-30: `Bid` used to store a `PubKeyHash`, which cannot
  reconstruct an address.** The two-bidder run demonstrated it rather than
  merely predicting it — see the gotcha above. `Bid` and `AuctionParams` now
  store an `Address`. The cost that remains worth discussing is a larger datum,
  and a structure the bidder supplied rather than one the chain derived.
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
