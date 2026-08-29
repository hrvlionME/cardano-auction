# Transactions

One module per transaction, matching the auction lifecycle:

| File | What it does |
|---|---|
| `mint-lot.ts` | spend the seed UTxO, mint the lot NFT |
| `open-auction.ts` | lock the NFT at the auction address with datum `Nothing` |
| `bid.ts` | spend the auction UTxO, pay the tagged refund, recreate with the new bid |
| `payout.ts` | after the deadline, pay the seller and deliver the lot |
| `claim.ts` | winner and seller co-sign, burn the NFT |

**The thing that will bite you:** `bid.ts` and `payout.ts` must attach the spent
auction UTxO's `TxOutRef` as an inline datum on every output that settles an
obligation -- the refund, the seller payment, the lot delivery. Use
`settlementTag()` from `../types.ts`. Without it the validator will not credit
the output and your own honest transaction is rejected. This is deliberate:
see the double-satisfaction section in ../../on-chain/README.md.
