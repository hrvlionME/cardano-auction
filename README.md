# plinth-auction

On-chain English auction for Cardano, written in Plinth (Plutus Tx).
Master's thesis project.

## Design

The auction is **one script UTxO**. Each bid spends it and recreates it with the
new highest bid in the datum, **refunding the displaced bidder in the same
transaction**. Because a losing bid comes back the instant it is beaten, there
is no bid-withdrawal path: at any moment the only locked funds belong to the
current highest bidder, who must not be allowed to withdraw anyway.

After the deadline, anyone may submit the `Payout` transaction; the validator
enforces that the seller gets the winning bid and the winner gets the lot token.

## Layout

| Path | What |
|---|---|
| `src/AuctionValidator.hs` | the validator: `NewBid` and `Payout` rules |
| `app/GenBlueprint.hs` | emits `plutus.json` (CIP-57) with the compiled script |
| `test/Fixtures.hs` | helpers for hand-building `ScriptContext` values |
| `test/Main.hs` | behaviour tests + the double-satisfaction exploit |
| `scripts/install-cardano-libs.sh` | builds libsodium/secp256k1/blst (needs sudo) |

## Running

    make build       # compile
    make test        # run tests
    make blueprint   # produce plutus.json
    make env         # check the toolchain is wired up

The first build compiles the whole Plutus stack from source and takes a long
time. Later builds are fast.

## Double satisfaction

The obligation checks (`refundsPreviousHighestBid`, `sellerGetsHighestBid`,
`highestBidderGetsAsset`) work by scanning `txInfoOutputs`. Asked naively —
*"is there an output paying X this amount?"* — one output answers for two
auctions at once, so a transaction spending two auction UTxOs could settle two
debts with a single payment and the attacker kept the difference as change.

The fix is to anchor every obligation to the input it belongs to. An output
counts towards this auction only if it carries this input's `TxOutRef` as its
datum (`settlesThisAuction`). A `TxOutRef` names one input of one transaction,
so no output can answer for two auctions.

Honest batching still works — settle several auctions in one transaction by
giving each its own output, tagged with the input it settles. The cost is that
off-chain code must attach that datum to refund and payout outputs.

`test/Main.hs` covers the attack from both sides: a shared untagged output is
credited to neither auction, a shared output tagged for auction A is credited
to A only, and two separately tagged outputs are credited to both.
