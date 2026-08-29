# plinth-auction

On-chain English auction for Cardano, written in Plinth (Plutus Tx).
Master's thesis project.

## Lifecycle

    mint  ->  auction  ->  deliver  ->  burn

The lot NFT is created, auctioned, handed to the winner, and destroyed when the
winner collects the physical item. The burn is the on-chain receipt.

## The lot token

An auction needs something on-chain to stand for the physical item. That is an
NFT minted by `src/LotMintingPolicy.hs`, a *one-shot* policy: it will only mint
if the transaction spends one specific UTxO, named as a compile-time parameter.
A UTxO can be spent once in the history of the chain, so the policy can succeed
once, and the token is provably unique. Each item gets its own policy, and
therefore its own `CurrencySymbol`.

The token is a **bearer claim** on the physical item: whoever holds it is
entitled to collect. Burning it is the winner redeeming that claim, and the
policy requires the seller's signature on the burn as well as the holder's
(spending the token needs the holder's key anyway). A burn is therefore a
two-party receipt, and a claim already redeemed is distinguishable on-chain
from one still outstanding.

What the chain cannot do is force anyone to hand over a laptop. The auction is
trustless; settlement of the physical good is not. The NFT narrows that gap by
making the claim provable and transferable, but it does not close it.

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
| `src/LotMintingPolicy.hs` | one-shot policy minting the NFT that stands for the item |
| `app/GenBlueprint.hs` | emits `plutus.json` (CIP-57) with both compiled scripts |
| `test/Fixtures.hs` | helpers for hand-building `ScriptContext` values |
| `test/Main.hs` | behaviour tests, minting tests, double-satisfaction tests |
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
