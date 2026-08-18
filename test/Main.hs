-- | Behavioural tests for the auction validator, including the
-- double-satisfaction exploit against the reference design.
module Main (main) where

import AuctionValidator
import Fixtures

import Control.Exception (SomeException, evaluate, try)
import PlutusLedgerApi.V3 (ScriptContext, TxInfo (..))
import Test.Tasty
import Test.Tasty.HUnit

{- | Run the validator as a plain function.

A failing check inside the validator calls 'PlutusTx.traceError', which under
GHC throws rather than returning 'False'. So "rejected" means either 'False' or
an exception, and we normalise both to 'False' here.
-}
accepts :: AuctionParams -> ScriptContext -> IO Bool
accepts p ctx = do
  r <- try (evaluate (auctionTypedValidator p ctx))
  pure $ case r of
    Left (_ :: SomeException) -> False
    Right b                   -> b

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

-- --------------------------------------------------------------- the exploit

{- | Double satisfaction.

Victim is the standing highest bidder on two separate auctions, at the same
amount. The attacker outbids on BOTH in a single transaction, but includes only
ONE refund output.

Each validator independently scans @txInfoOutputs@ asking "is there an output
paying victim 100 ADA?" — and both find the same output. Both accept. The victim
is refunded 100 ADA instead of 200, and the attacker keeps the difference as
change.

Against the reference implementation this test FAILS, which is the point: it
documents the vulnerability. It should pass once the validator anchors each
obligation to its own input.
-}
doubleSatisfaction :: TestTree
doubleSatisfaction =
  testCase "one refund output cannot satisfy two auctions" $ do
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
      ( "SECURITY: both auctions accepted a transaction carrying a single "
          <> "refund output for two distinct refund obligations. "
          <> "Victim was underpaid by 100 ADA."
      )
      (not (okA && okB))

-- | The same flaw on the settlement path: one payout output, two sellers' worth
-- of obligation.
doubleSatisfactionPayout :: TestTree
doubleSatisfactionPayout =
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
                [ payTo seller (ada 100_000_000) -- ONE payout, two owed
                , payTo alice (ada 2_000_000 <> lot lotA)
                , payTo alice (ada 2_000_000 <> lot lotB)
                ]
            , txInfoValidRange = afterDeadline
            }

    okA <- accepts paramsA (ctxFor sharedTxInfo refA dA Payout)
    okB <- accepts paramsB (ctxFor sharedTxInfo refB dB Payout)

    assertBool
      "SECURITY: one payout output satisfied two sellers' obligations"
      (not (okA && okB))

main :: IO ()
main =
  defaultMain $
    testGroup
      "auction validator"
      [ testGroup
          "well-formed transactions"
          [ firstBidAccepted
          , belowReserveRejected
          , lateBidRejected
          , missingRefundRejected
          ]
      , testGroup
          "double satisfaction"
          [ doubleSatisfaction
          , doubleSatisfactionPayout
          ]
      ]
