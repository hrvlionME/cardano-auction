-- | Behavioural tests for the auction validator, including the
-- double-satisfaction attack the input-anchored obligations defend against.
module Main (main) where

import AuctionValidator
import Fixtures
import LotMintingPolicy

import Control.Exception (SomeException, evaluate, try)
import PlutusLedgerApi.V3 (ScriptContext, TxInfo (..), TxOutRef)
import Test.Tasty
import Test.Tasty.HUnit

{- | Run the validator as a plain function.

A failing check inside the validator calls 'PlutusTx.traceError', which under
GHC throws rather than returning 'False'. So "rejected" means either 'False' or
an exception, and we normalise both to 'False' here.
-}
runs :: Bool -> IO Bool
runs ~b = do
  -- The lazy pattern above matters: this module is compiled with Strict, which
  -- would otherwise force the argument before 'try' is installed and let the
  -- traceError escape uncaught.
  r <- try (evaluate b)
  pure $ case r of
    Left (_ :: SomeException) -> False
    Right ok                  -> ok

accepts :: AuctionParams -> ScriptContext -> IO Bool
accepts p ctx = runs (auctionTypedValidator p ctx)

-- | The same, for the lot minting policy.
mints :: LotParams -> ScriptContext -> IO Bool
mints p ctx = runs (lotTypedPolicy p ctx)

paramsA :: AuctionParams
paramsA = params scriptHashA lotA 50_000_000

paramsB :: AuctionParams
paramsB = params scriptHashB lotB 50_000_000

-- ------------------------------------------------------------ sanity tests

-- | Alice opens the bidding on an auction with no standing bid.
firstBidAccepted :: TestTree
firstBidAccepted = testCase "first bid at/above reserve is accepted" $ do
  let d = AuctionDatum Nothing
      bid = Bid alice 60_000_000
      ref = txOutRefOf 0
      txInfo =
        emptyTxInfo
          { txInfoInputs = [auctionInput ref scriptHashA lotA 2_000_000 d]
          , txInfoOutputs =
              [continuing scriptHashA (ada 60_000_000 <> lot lotA) (AuctionDatum (Just bid))]
          }
  ok <- accepts paramsA (ctxFor txInfo ref d (NewBid bid))
  assertBool "honest opening bid should be accepted" ok

-- | The ordinary case: outbid the standing bidder and hand their money back,
-- tagged with the auction UTxO being spent.
honestOutbidAccepted :: TestTree
honestOutbidAccepted = testCase "outbidding with a tagged refund is accepted" $ do
  let standing = Bid victim 100_000_000
      d = AuctionDatum (Just standing)
      bid = Bid alice 150_000_000
      ref = txOutRefOf 0
      txInfo =
        emptyTxInfo
          { txInfoInputs = [auctionInput ref scriptHashA lotA 100_000_000 d]
          , txInfoOutputs =
              [ payToFor ref victim (ada 100_000_000)
              , continuing scriptHashA (ada 150_000_000 <> lot lotA) (AuctionDatum (Just bid))
              ]
          }
  ok <- accepts paramsA (ctxFor txInfo ref d (NewBid bid))
  assertBool "honest outbid with a correctly tagged refund should be accepted" ok

-- | Settlement after the deadline: seller takes the money, winner takes the lot.
honestPayoutAccepted :: TestTree
honestPayoutAccepted = testCase "tagged payout after the deadline is accepted" $ do
  let win = Bid alice 100_000_000
      d = AuctionDatum (Just win)
      ref = txOutRefOf 0
      txInfo =
        emptyTxInfo
          { txInfoInputs = [auctionInput ref scriptHashA lotA 100_000_000 d]
          , txInfoOutputs =
              [ payToFor ref seller (ada 100_000_000)
              , payToFor ref alice (ada 2_000_000 <> lot lotA)
              ]
          , txInfoValidRange = afterDeadline
          }
  ok <- accepts paramsA (ctxFor txInfo ref d Payout)
  assertBool "honest settlement should be accepted" ok

belowReserveRejected :: TestTree
belowReserveRejected = testCase "bid below the reserve is rejected" $ do
  let d = AuctionDatum Nothing
      bid = Bid alice 10_000_000
      ref = txOutRefOf 0
      txInfo =
        emptyTxInfo
          { txInfoInputs = [auctionInput ref scriptHashA lotA 2_000_000 d]
          , txInfoOutputs =
              [continuing scriptHashA (ada 10_000_000 <> lot lotA) (AuctionDatum (Just bid))]
          }
  ok <- accepts paramsA (ctxFor txInfo ref d (NewBid bid))
  assertBool "under-reserve bid must be rejected" (not ok)

lateBidRejected :: TestTree
lateBidRejected = testCase "bid after the deadline is rejected" $ do
  let d = AuctionDatum Nothing
      bid = Bid alice 60_000_000
      ref = txOutRefOf 0
      txInfo =
        emptyTxInfo
          { txInfoInputs = [auctionInput ref scriptHashA lotA 2_000_000 d]
          , txInfoOutputs =
              [continuing scriptHashA (ada 60_000_000 <> lot lotA) (AuctionDatum (Just bid))]
          , txInfoValidRange = afterDeadline
          }
  ok <- accepts paramsA (ctxFor txInfo ref d (NewBid bid))
  assertBool "bid past the deadline must be rejected" (not ok)

-- | The core guarantee of the single-UTxO design: you cannot displace someone
-- without handing their money back in the same transaction.
missingRefundRejected :: TestTree
missingRefundRejected = testCase "outbidding without refunding is rejected" $ do
  let standing = Bid victim 100_000_000
      d = AuctionDatum (Just standing)
      bid = Bid alice 150_000_000
      ref = txOutRefOf 0
      txInfo =
        emptyTxInfo
          { txInfoInputs = [auctionInput ref scriptHashA lotA 100_000_000 d]
          , txInfoOutputs =
              -- note: no refund output to victim
              [continuing scriptHashA (ada 150_000_000 <> lot lotA) (AuctionDatum (Just bid))]
          }
  ok <- accepts paramsA (ctxFor txInfo ref d (NewBid bid))
  assertBool "displacing a bidder without refunding must be rejected" (not ok)

-- --------------------------------------------------- double satisfaction

{- | An untagged refund does not count.

This is the mechanism the defence rests on, tested in isolation: the victim is
paid the right amount at the right address, but the output does not name the
auction UTxO it settles, so the validator will not credit it.
-}
untaggedRefundRejected :: TestTree
untaggedRefundRejected = testCase "an untagged refund does not settle the debt" $ do
  let standing = Bid victim 100_000_000
      d = AuctionDatum (Just standing)
      bid = Bid alice 150_000_000
      ref = txOutRefOf 0
      txInfo =
        emptyTxInfo
          { txInfoInputs = [auctionInput ref scriptHashA lotA 100_000_000 d]
          , txInfoOutputs =
              [ payTo victim (ada 100_000_000) -- correct, but carries no tag
              , continuing scriptHashA (ada 150_000_000 <> lot lotA) (AuctionDatum (Just bid))
              ]
          }
  ok <- accepts paramsA (ctxFor txInfo ref d (NewBid bid))
  assertBool "a refund output with no input tag must not count" (not ok)

{- | Double satisfaction, the original attack.

Victim is the standing highest bidder on two separate auctions, at the same
amount. The attacker outbids on BOTH in a single transaction, but includes only
ONE refund output.

Before the fix, each validator independently scanned @txInfoOutputs@ asking "is
there an output paying victim 100 ADA?" — and both found the same output. Both
accepted, the victim was refunded 100 ADA instead of 200, and the attacker kept
the difference as change.

Now the shared output carries no input tag, so neither auction credits it.
-}
sharedUntaggedRefund :: TestTree
sharedUntaggedRefund =
  testCase "one untagged refund cannot satisfy two auctions" $ do
    let standing = Bid victim 100_000_000
        dA = AuctionDatum (Just standing)
        dB = AuctionDatum (Just standing)
        bidA = Bid attacker 150_000_000
        bidB = Bid attacker 150_000_000
        refA = txOutRefOf 0
        refB = txOutRefOf 1

        sharedTxInfo =
          emptyTxInfo
            { txInfoInputs =
                [ auctionInput refA scriptHashA lotA 100_000_000 dA
                , auctionInput refB scriptHashB lotB 100_000_000 dB
                ]
            , txInfoOutputs =
                [ -- ONE refund, where two are owed
                  payTo victim (ada 100_000_000)
                , continuing scriptHashA (ada 150_000_000 <> lot lotA) (AuctionDatum (Just bidA))
                , continuing scriptHashB (ada 150_000_000 <> lot lotB) (AuctionDatum (Just bidB))
                ]
            }

    okA <- accepts paramsA (ctxFor sharedTxInfo refA dA (NewBid bidA))
    okB <- accepts paramsB (ctxFor sharedTxInfo refB dB (NewBid bidB))

    assertBool
      ( "SECURITY: an auction accepted a transaction carrying a single "
          <> "untagged refund output for two distinct refund obligations."
      )
      (not okA && not okB)

{- | The sharper statement of the fix.

The attacker is allowed to tag the shared refund — but a tag names exactly one
input, so it buys them exactly one auction. The second still demands its own
refund and rejects. The victim can no longer be underpaid.
-}
taggedRefundCountsOnce :: TestTree
taggedRefundCountsOnce =
  testCase "a tagged refund settles exactly one auction, not two" $ do
    let standing = Bid victim 100_000_000
        dA = AuctionDatum (Just standing)
        dB = AuctionDatum (Just standing)
        bidA = Bid attacker 150_000_000
        bidB = Bid attacker 150_000_000
        refA = txOutRefOf 0
        refB = txOutRefOf 1

        sharedTxInfo =
          emptyTxInfo
            { txInfoInputs =
                [ auctionInput refA scriptHashA lotA 100_000_000 dA
                , auctionInput refB scriptHashB lotB 100_000_000 dB
                ]
            , txInfoOutputs =
                [ -- ONE refund, tagged for auction A only
                  payToFor refA victim (ada 100_000_000)
                , continuing scriptHashA (ada 150_000_000 <> lot lotA) (AuctionDatum (Just bidA))
                , continuing scriptHashB (ada 150_000_000 <> lot lotB) (AuctionDatum (Just bidB))
                ]
            }

    okA <- accepts paramsA (ctxFor sharedTxInfo refA dA (NewBid bidA))
    okB <- accepts paramsB (ctxFor sharedTxInfo refB dB (NewBid bidB))

    assertBool "the auction the refund was tagged for should accept" okA
    assertBool
      "SECURITY: a refund tagged for auction A also satisfied auction B"
      (not okB)

-- | The same flaw on the settlement path: one payout output, two sellers' worth
-- of obligation.
sharedPayoutRejected :: TestTree
sharedPayoutRejected =
  testCase "one payout output cannot satisfy two auctions" $ do
    let winA = Bid alice 100_000_000
        winB = Bid alice 100_000_000
        dA = AuctionDatum (Just winA)
        dB = AuctionDatum (Just winB)
        refA = txOutRefOf 0
        refB = txOutRefOf 1

        sharedTxInfo =
          emptyTxInfo
            { txInfoInputs =
                [ auctionInput refA scriptHashA lotA 100_000_000 dA
                , auctionInput refB scriptHashB lotB 100_000_000 dB
                ]
            , txInfoOutputs =
                [ payToFor refA seller (ada 100_000_000) -- ONE payout, two owed
                , payToFor refA alice (ada 2_000_000 <> lot lotA)
                , payToFor refA alice (ada 2_000_000 <> lot lotB)
                ]
            , txInfoValidRange = afterDeadline
            }

    okA <- accepts paramsA (ctxFor sharedTxInfo refA dA Payout)
    okB <- accepts paramsB (ctxFor sharedTxInfo refB dB Payout)

    assertBool "the auction the payout was tagged for should accept" okA
    assertBool
      "SECURITY: one payout output satisfied two sellers' obligations"
      (not okB)

{- | The fix must not outlaw honest batching.

Settling two auctions in one transaction stays legal, as long as each auction
gets its own output tagged with its own input. Only sharing is forbidden.
-}
honestBatchAccepted :: TestTree
honestBatchAccepted =
  testCase "two auctions settle in one tx when each refund is tagged" $ do
    let standing = Bid victim 100_000_000
        dA = AuctionDatum (Just standing)
        dB = AuctionDatum (Just standing)
        bidA = Bid alice 150_000_000
        bidB = Bid alice 150_000_000
        refA = txOutRefOf 0
        refB = txOutRefOf 1

        sharedTxInfo =
          emptyTxInfo
            { txInfoInputs =
                [ auctionInput refA scriptHashA lotA 100_000_000 dA
                , auctionInput refB scriptHashB lotB 100_000_000 dB
                ]
            , txInfoOutputs =
                [ payToFor refA victim (ada 100_000_000)
                , payToFor refB victim (ada 100_000_000)
                , continuing scriptHashA (ada 150_000_000 <> lot lotA) (AuctionDatum (Just bidA))
                , continuing scriptHashB (ada 150_000_000 <> lot lotB) (AuctionDatum (Just bidB))
                ]
            }

    okA <- accepts paramsA (ctxFor sharedTxInfo refA dA (NewBid bidA))
    okB <- accepts paramsB (ctxFor sharedTxInfo refB dB (NewBid bidB))

    assertBool "auction A should accept its own tagged refund" okA
    assertBool "auction B should accept its own tagged refund" okB

-- ------------------------------------------------------- lot minting policy

seedRef :: TxOutRef
seedRef = txOutRefOf 7

lotParams :: LotParams
lotParams = LotParams {lpSeedRef = seedRef, lpTokenName = lotA, lpSeller = seller}

-- | The transaction that creates the lot NFT: it spends the seed UTxO and
-- mints exactly one token.
oneShotMintAccepted :: TestTree
oneShotMintAccepted = testCase "minting one lot while spending the seed is accepted" $ do
  let txInfo =
        emptyTxInfo
          { txInfoInputs = [plainInput seedRef seller (ada 5_000_000)]
          , txInfoMint = mintOf lotPolicy [(lotA, 1)]
          }
  ok <- mints lotParams (mintCtx txInfo lotPolicy)
  assertBool "the one-shot mint should be accepted" ok

{- | The uniqueness guarantee.

Once the seed UTxO has been spent, no later transaction can consume it again,
so no later transaction can satisfy this policy. Minting a second copy of the
lot is impossible for the lifetime of the chain -- which is what makes the
token trustworthy as a stand-in for the physical item.
-}
mintWithoutSeedRejected :: TestTree
mintWithoutSeedRejected = testCase "minting without the seed UTxO is rejected" $ do
  let txInfo =
        emptyTxInfo
          { -- some other UTxO, not the seed
            txInfoInputs = [plainInput (txOutRefOf 99) attacker (ada 5_000_000)]
          , txInfoMint = mintOf lotPolicy [(lotA, 1)]
          }
  ok <- mints lotParams (mintCtx txInfo lotPolicy)
  assertBool "SECURITY: a second lot was minted without the seed" (not ok)

mintingTwoRejected :: TestTree
mintingTwoRejected = testCase "minting quantity two is rejected" $ do
  let txInfo =
        emptyTxInfo
          { txInfoInputs = [plainInput seedRef seller (ada 5_000_000)]
          , txInfoMint = mintOf lotPolicy [(lotA, 2)]
          }
  ok <- mints lotParams (mintCtx txInfo lotPolicy)
  assertBool "SECURITY: the lot is not unique if two can be minted at once" (not ok)

wrongTokenNameRejected :: TestTree
wrongTokenNameRejected = testCase "minting a different token name is rejected" $ do
  let txInfo =
        emptyTxInfo
          { txInfoInputs = [plainInput seedRef seller (ada 5_000_000)]
          , txInfoMint = mintOf lotPolicy [(lotB, 1)]
          }
  ok <- mints lotParams (mintCtx txInfo lotPolicy)
  assertBool "only the lot named in the parameters may be minted" (not ok)

-- | Checking the whole map, rather than looking up one name, is what catches
-- this: the seed is spent legitimately, but extra assets ride along.
extraTokenNameRejected :: TestTree
extraTokenNameRejected = testCase "minting extra token names alongside the lot is rejected" $ do
  let txInfo =
        emptyTxInfo
          { txInfoInputs = [plainInput seedRef seller (ada 5_000_000)]
          , txInfoMint = mintOf lotPolicy [(lotA, 1), (lotB, 1)]
          }
  ok <- mints lotParams (mintCtx txInfo lotPolicy)
  assertBool "SECURITY: extra tokens were minted under the lot's policy" (not ok)

-- ------------------------------------------------ claiming the item (burn)

{- | Burning is the winner redeeming the coupon for the physical laptop.

Spending the token already requires the holder's key, so demanding the
seller's signature on top makes the burn a two-party handshake: on-chain
evidence that both sides were present for the handover. Note the seed UTxO is
long gone by now, and is not required.
-}
burnWithSellerSignatureAccepted :: TestTree
burnWithSellerSignatureAccepted = testCase "burning the lot with the seller's signature is accepted" $ do
  let txInfo =
        emptyTxInfo
          { txInfoInputs = [plainInput (txOutRefOf 42) alice (ada 2_000_000 <> lot lotA)]
          , txInfoMint = mintOf lotPolicy [(lotA, -1)]
          , txInfoSignatories = [alice, seller]
          }
  ok <- mints lotParams (mintCtx txInfo lotPolicy)
  assertBool "a co-signed burn should be accepted" ok

-- | Without the seller the burn is unilateral, and proves nothing about
-- whether the item ever changed hands.
burnWithoutSellerRejected :: TestTree
burnWithoutSellerRejected = testCase "burning without the seller's signature is rejected" $ do
  let txInfo =
        emptyTxInfo
          { txInfoInputs = [plainInput (txOutRefOf 42) alice (ada 2_000_000 <> lot lotA)]
          , txInfoMint = mintOf lotPolicy [(lotA, -1)]
          , txInfoSignatories = [alice]
          }
  ok <- mints lotParams (mintCtx txInfo lotPolicy)
  assertBool "an unwitnessed burn must be rejected" (not ok)

-- | Only 1 and -1 are meaningful for a token that is supposed to be unique.
oddQuantityRejected :: TestTree
oddQuantityRejected = testCase "burning a quantity other than one is rejected" $ do
  let txInfo =
        emptyTxInfo
          { txInfoInputs = [plainInput (txOutRefOf 42) alice (ada 2_000_000 <> lot lotA)]
          , txInfoMint = mintOf lotPolicy [(lotA, -2)]
          , txInfoSignatories = [alice, seller]
          }
  ok <- mints lotParams (mintCtx txInfo lotPolicy)
  assertBool "only -1 may be burned" (not ok)

main :: IO ()
main =
  defaultMain $
    testGroup
      "auction validator"
      [ testGroup
          "well-formed transactions"
          [ firstBidAccepted
          , honestOutbidAccepted
          , honestPayoutAccepted
          , belowReserveRejected
          , lateBidRejected
          , missingRefundRejected
          ]
      , testGroup
          "lot minting policy"
          [ oneShotMintAccepted
          , mintWithoutSeedRejected
          , mintingTwoRejected
          , wrongTokenNameRejected
          , extraTokenNameRejected
          ]
      , testGroup
          "claiming the item"
          [ burnWithSellerSignatureAccepted
          , burnWithoutSellerRejected
          , oddQuantityRejected
          ]
      , testGroup
          "double satisfaction"
          [ untaggedRefundRejected
          , sharedUntaggedRefund
          , taggedRefundCountsOnce
          , sharedPayoutRejected
          , honestBatchAccepted
          ]
      ]
