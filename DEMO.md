# Demonstration runbook

How to show this working, live, without reconstructing the commands from
memory. Read `CLAUDE.md` for the design; this file is only the script for
driving it.

Everything runs on **Preview** with throwaway wallets. Nothing here touches
mainnet or real value.

---

## Before you start

Check the wallets are funded and the two halves still agree:

    cd off-chain && deno task info
    cd off-chain && deno task verify-lot

`verify-lot` re-derives each minted token's policy id from the current code and
compares it to the id the token was actually minted under. If it reports DRIFT,
the Haskell has changed since those tokens were minted and every address the
code computes is wrong — stop and rebuild (`cd on-chain && make blueprint`)
before demonstrating anything.

Three parties are configured, all seeds in `off-chain/.env` (gitignored):

| role | env var | plays |
|---|---|---|
| seller / operator | `WALLET_SEED_PHRASE` | mints the lot, opens the auction, co-signs the burn |
| bidder 1 | `BIDDER1_SEED_PHRASE` | bids, gets outbid, gets refunded |
| bidder 2 | `BIDDER2_SEED_PHRASE` | outbids, wins, burns the token |

Bidders are funded from the seller wallet, not the faucet — faster, and no
captcha. If you need another, add `BIDDER3_SEED_PHRASE`; `bidderIndices()`
picks it up with no code change.

---

## Part A — instant, offline, safe to run live

No network, no wallet, no fees. Each takes about a second, so these are the
parts to run in front of an audience with no risk at all.

    cd on-chain  && make test
    cd off-chain && deno task smoke
    cd off-chain && deno task verify-lot

**`make test` is the strongest single exhibit.** Twenty-two tests, and the
group names carry the argument:

- `double satisfaction` (5 tests) — the security contribution. One test shows
  the attack failing; one shows that honest batching of two auctions in a
  single transaction still succeeds, so the defence is not merely a blanket ban.
- `refund addresses` (3 tests) — the defect found on-chain and then fixed. The
  first of them, *"a refund to the right key at the wrong address is
  rejected"*, is exactly what the old code accepted.

**`deno task smoke`** checks that the TypeScript and Haskell agree on every
encoding: constructor tags, round-trips, the settlement tag, and that a base
and an enterprise address on the same key do not encode identically. A
mismatch here would otherwise surface only as an opaque "failed to parse
datum", two minutes and one fee later.

---

## Part B — the live lifecycle

About twenty minutes end to end. Each transaction needs a block, so budget one
to two minutes per step.

**Run `deno task info` between every step.** That is the demonstration: one
command, telling a different story each time, with the parties named rather
than shown as addresses.

    cd off-chain

    deno task mint-lot DEMOLOT              # one-shot NFT; prints a policy id
    deno task open-auction 5 15 <prefix>    # 5 ADA reserve, closes in 15 min
    deno task bid 7 --as 1 <prefix>         # bidder 1 opens
    deno task bid 9 --as 2 <prefix>         # bidder 2 outbids
                                            # ... wait for the deadline ...
    deno task payout <prefix>               # seller paid, lot delivered
    deno task claim <prefix>                # two signatures, token burned

`<prefix>` is any prefix of the policy id that `mint-lot` printed — eight
characters is plenty. It is only needed because several lots are on disk.

### What to say at each step

**`mint-lot`** — the policy demands one specific UTxO be spent. A UTxO can be
spent once in the history of the chain, so this policy can succeed once. That
is what makes the token a genuine NFT and therefore trustworthy as a stand-in
for the physical item.

**`open-auction`** — the NFT is now locked at a script address with datum
`d87a80`, which is `Nothing`: no bids yet. Worth saying out loud that **no
script ran here.** The ledger executes a validator when you *spend* from its
address, never when you pay *to* it. This is an ordinary payment that happens
to be addressed to a script.

**First bid** — `info` now shows `leader: bidder 1`. This is the first
transaction in which a validator actually executes.

**Second bid — the one to dwell on.** `info` shows `leader: bidder 2`, and
**bidder 1's balance has gone back up.** They were refunded in the very
transaction that displaced them. That is why there is no withdraw-my-bid
endpoint anywhere in the contract: a losing bid is returned the instant it is
beaten, so the only locked funds at any moment belong to the current leader —
who must not be allowed to withdraw anyway.

Also point at the refund output's datum. It carries the *spent auction UTxO's*
`TxOutRef`. Without that tag the validator refuses to credit the output, which
is the double-satisfaction defence working as designed.

**`payout`** — legal only from the deadline onward. Note that the command waits
for the *chain tip* to reach the deadline, not merely the wall clock; see
Troubleshooting.

**`claim`** — the burn. Two signatures: the holder's, because spending the
token needs their key, and the seller's, because the policy demands it. The
burn is therefore a two-party receipt — on-chain evidence that both sides were
present for the handover. `info` afterwards reports `total supply now: 0` and
`mint/burn events: 2`. The coupon existed exactly once and was redeemed
exactly once.

---

## Part C — failure demos

These refuse *before* building a transaction, so they are instant, free, and
cannot go wrong in front of an audience. They show that the rules are real.

    deno task bid 3 --as 1 <prefix>    # below the reserve
    deno task bid 6 --as 1 <prefix>    # below the standing bid
    deno task payout <prefix>          # before the deadline

Errors print as plain sentences. `DEBUG=1` restores the full stack trace when
you actually need it.


---

## Part D — the indexer and the read API

Optional, and a different kind of demonstration: Parts A–C show the contract
working, this shows an application built *around* it.

The indexer stores into MariaDB, so the server has to be up. Once per machine:

    sudo systemctl start mariadb
    sudo mariadb < off-chain/sql/setup.sql

Then:

    cd off-chain
    deno task sync              # replay every known auction from the chain
    deno task serve --sync      # HTTP API on :8000, syncing while it serves

Then, in another terminal:

    curl -s localhost:8000/health | jq
    curl -s localhost:8000/auctions | jq
    curl -s localhost:8000/auctions/<policyId> | jq
    curl -s localhost:8000/auctions/<policyId>/events | jq

### The two points worth making

**The database is not authoritative, and can be proved so.** Destroy it
completely and watch it come back:

    deno task db:reset

That drops every table, recreates them, and re-syncs from the chain. It prints
what it dropped and what returned, and the two match, because everything in it
is derived. Syncing is idempotent — each event is keyed by
(auction, transaction), so a sync can be interrupted at any point and simply
run again.

**This is the sentence to say while it runs:** a conventional auction site
cannot survive this demonstration. Drop its tables and the bids are gone, because
the bids only ever existed there. Here the database is a cache of something that
already happened on a ledger nobody in this room controls.

If you want to see it in SQL rather than through the CLI, MariaDB is right
there:

    mariadb -u auction -pauction auction_indexer -e "SELECT token_name, status FROM auctions"
    mariadb -u auction -pauction auction_indexer -e "SELECT kind, amount, tx_hash FROM events ORDER BY block_height"

**The API is read-only, and that is the design.** It holds no keys and signs
nothing. `POST` returns 405 with *"This API is read-only. State changes are
signed transactions."* Say plainly what that buys: this server can lag, crash,
serve stale data, or lie outright, and no bidder loses a lovelace. The worst it
can do is mislead someone about the state of an auction — a real harm, but a
far smaller one than being able to take funds. A conventional auction site's
backend can do both. Bidding goes through a wallet, which is what
`deno task bid` demonstrates.

### The limitation to volunteer

Because `AuctionParams` are compile-time parameters, every auction is a
different script at a different address. **There is no "auction contract" to
watch.** The indexer holds a list of addresses and can only ever learn about
auctions it was told about — here, from `state/auction-*.json`; in a deployed
system, from a table the API writes at creation time. Either way, an auction
opened by a stranger against the same validator source but with different
parameters is invisible to this indexer forever.

That is the concrete cost of compile-time parameters, and it is the practical
argument for the alternative design: parameters in the datum, one shared
script, one address to watch — at the price of validating parameters the chain
did not derive. It is documented at the top of `src/indexer/sync.ts`.

---

## Part E — the web app

This is the part to show a non-technical audience. Everything before it proves
the contracts work; this makes that visible without a terminal.

    cd off-chain
    deno task web:build            # once, after any change to the Haskell
    deno task serve --sync         # API + chain proxy + the page, one port

Then open **http://localhost:8000/**.

While developing, `deno task web` instead gives a Vite dev server on :5173 with
hot reload, proxying to :8000 — but for a demo use the single port, because
there is one thing to start and one thing that can fail.

### Connecting a wallet

The page lists whatever CIP-30 wallets the browser has and puts Eternl first.
**Nothing here is Eternl-specific** — CIP-30 is the standard every Cardano
browser wallet implements, and Lace, Nami, Flint, Typhon and Vespr all satisfy
the same interface. Set the wallet to **Preview** before connecting; if it is on
mainnet the page says so plainly instead of failing later with something
cryptic.

Import one of the bidder seed phrases from `off-chain/.env` into a fresh Eternl
profile to bid as bidder 1 or 2.

### What to say while it is on screen

**"The page cannot spend anything."** Pressing *Place bid* builds a transaction
and hands it to the wallet, which shows it to you and waits. Refuse it and
nothing happens. The private key never leaves the extension, and the page never
sees it.

**"The server cannot spend anything either."** It holds the Blockfrost key, so
the browser never has to — but a Blockfrost key reads the chain and relays
already-signed transactions. It cannot sign. There is no private key anywhere in
this system except inside the wallet.

**"This is the same code the command line runs."** The browser imports `bid()`
from `src/tx/bid.ts` — the same function, same Plutus schemas, same parameter
application. Only the wallet and the provider differ. That matters because a
second transaction builder is exactly where a datum schema drifts by one
constructor tag, and that failure appears on-chain after a fee, not at build
time.

**The lag is honest, so narrate it.** After a bid the page shows *"on its way to
the chain"* and does not update for up to a minute. That is not a bug: the page
reads the chain, and the chain has to mint a block before there is anything to
read. A conventional site would show the bid instantly because its own database
recorded it — which is precisely the thing this design refuses to do.

### The demonstration that lands

Have a terminal beside the browser. Run:

    deno task bid 11 --as 1 <prefix>

and say nothing. The page updates on its own a few seconds later. The browser
was never told; it read the chain. Two completely different clients — a CLI with
a seed phrase and a browser with a wallet extension — writing to one ledger and
both seeing the same truth.

---

## What to claim, and what not to

Be precise about the boundary; it is the sort of thing an examiner will push on.

**The chain guarantees** that the money moved, that a displaced bidder was
refunded in the same transaction, that the lot is unique, and that both parties
signed off on the handover.

**The chain cannot guarantee** that a laptop exists, or that it was handed
over. The burn records that both parties *said* it was. The seller is the app
operator, so users trust the operator for physical delivery and the chain for
the money — never the other way round.

Two limitations worth volunteering rather than being asked about:

- Nobody is paid to submit `payout`, and whoever submits it funds the winner's
  min-ADA out of pocket.
- The seller fronts min-ADA when opening, and the *first bidder* pockets it as
  change, because `correctOutput` requires the continuing output to hold
  exactly the bid and not a lovelace more.

---

## Evidence from previous runs

Three complete runs on Preview, each ending in a burned token
(`quantity 0, mint_or_burn_count 2` per Blockfrost). Look any of these up on a
Preview explorer such as `preview.cardanoscan.io`.

**TESTLOT** `1f5c4baf…` — the no-bid path. `Payout` with `Nothing` returns the
lot to the seller, then a single-signature burn, since the seller is also the
holder.

    mint    7b7e43c0ac1bc8768e426f58b580bca633952c430522f6f18830793a27526921
    payout  0e628f59287a8edeab253773049a00298f7d220516f21988681fc6c1e39efe77
    claim   62b5dddcf178e2411755806308fb954a052cf0f67c82a011b4e17f3992c62ce0

**TESTLOT2** `5e889b6a…` — four bids, two bidders displacing each other. **This
run exposed the `PubKeyHash` defect.**

    open    2237cb376b2a0fdd6ca699aa483914139b4f0f4ddda1d6960465d3612eef5f4d
    bid  7  dc657cbc6311218feeef4e5ef2f95d15ab9053c06f2b1661dec865b93ff13fd2
    bid  9  9401160093da9a1abf84fa90dced9cef1372838f7244d241208bba87a886761a
    bid 11  ad79efd1beb4aafab3507e339efbb95fa3248688eea87a24e8f5d04a639afee0
    bid 13  5b7a016ed426be82782e193dd47e90274a2d3caa653946459085eccbaa9224a3
    payout  4146b8fe91b1a71f01cd17085ef7cd6f0e93a6a57d75a03338064eb979915600
    claim   3cff5c932973200a075881d321ef5b4963cc57ae662bd0d3983e85afe3a3b6cc

Every refund in that run was paid correctly and landed at an address the
recipient's wallet does not watch. Bidder 1 accumulated **18 test ADA of their
own money, invisible**, and the burn failed outright — the lot arrived at an
address holding 2 ADA while 190 ADA sat at the same key's other address, and a
wallet spends from one address at a time.

**TESTLOT3** `660cf932…` — the same scenario after the fix.

    open    cee4156ddfccd26193b7bf20b9b537e1ca5c57e98bc91671a4dd006d225835b8
    bid  7  5e6b02a1dafdb015b975342f72c4985810906be5cb1ea8fddf57bff59c84a231
    bid  9  a3890311a45f2037e43e04fcd67db246276f9dcc8cb68fe2439dc5043a6b2503
    payout  fe0ff2254853af26a20c1c1786054a7354b03aab60e559c953d0505acb4e65c0
    claim   03bb03a170cb1774db8eb464782cb6f9864f59ef65ca9c19c12654fe79520e64

The cross-party refund reached bidder 1's real wallet, their enterprise address
stayed empty, and the burn needed no recovery step. The `sweep` command that
existed only to mop up after this defect has been deleted.

This is the best story in the project, so tell it as a story: built it, tested
it with two independent parties, found something a single-wallet test
structurally cannot find, diagnosed it, fixed it on-chain, and removed the
workaround.

---

## Troubleshooting

**"Wallet does not hold X" right after minting.** Blockfrost's per-address
index trails the block by a few seconds. Wait half a minute and re-run. Nothing
is wrong.

**`payout` says the chain has not caught up.** The node validates a lower
validity bound against its *tip*, and on Preview the tip can trail wall-clock
time by a minute or more between blocks. The deadline passing by your clock is
not the same claim as the chain agreeing it has passed. `payout` waits for the
tip on its own and reports which slot it is waiting for.

**`OutsideValidityIntervalUTxO` on submission.** The same thing, at the node
rather than in the guard. Wait for another block.

**A bid is rejected as too late.** The whole validity range must sit before the
deadline. If the auction is closed, settle it with `payout` — there is no way
to reopen one.

**`verify-lot` reports DRIFT.** The Haskell changed and script hashes moved.
Run `cd on-chain && make blueprint`, then `deno task verify-lot` again. Tokens
minted under an older policy will not match, and that is correct: they belong
to a different policy.

---

## Rehearse, and record a fallback

Rehearse the whole of Part B once on a throwaway lot — `DEMOLOT`, never
`LAPTOP`. `LAPTOP` (`ae7a1d01…`) is deliberately kept clean and unspent so the
run you screenshot for the thesis is not polluted by debugging.

Twenty minutes of live blockchain in front of an examiner is a real risk.
Record a rehearsal:

    script -c 'bash demo-sequence.sh' demo.log

or use `asciinema`. Then, if Preview is slow on the day, fall back to the
transcript and still run Part A live — it is instant and needs no network.

Keep `deno task info` open in a second terminal throughout.
