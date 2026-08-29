-- | Helpers for hand-building 'ScriptContext' values in tests.
--
-- We test 'auctionTypedValidator' directly as an ordinary Haskell function
-- rather than running compiled Plutus Core. That is enough to exercise the
-- validator's *logic*, which is where double satisfaction lives.
module Fixtures where

import AuctionValidator

import PlutusLedgerApi.V1.Address (Address (..))
import PlutusLedgerApi.V1.Credential (Credential (..))
import PlutusLedgerApi.V1.Interval (from, to)
import PlutusLedgerApi.V1.Value (CurrencySymbol (..), TokenName (..), Value, adaSymbol, adaToken,
                                 singleton)
import PlutusLedgerApi.V3 (Datum (..), Lovelace (..), OutputDatum (..), POSIXTime, POSIXTimeRange,
                           PubKeyHash (..), Redeemer (..), ScriptContext (..), ScriptHash (..),
                           ScriptInfo (..), TxId (..), TxInInfo (..), TxInfo (..), TxOut (..),
                           TxOutRef (..))
import PlutusLedgerApi.V3.MintValue (MintValue (..), emptyMintValue)
import PlutusTx (ToData, toBuiltinData)
import PlutusTx.AssocMap qualified as AssocMap

-- ---------------------------------------------------------------- identities

seller, alice, victim, attacker :: PubKeyHash
seller = PubKeyHash "seller__________________________"
alice = PubKeyHash "alice___________________________"
victim = PubKeyHash "victim__________________________"
attacker = PubKeyHash "attacker________________________"

-- | Two distinct auctions => two distinct script addresses.
scriptHashA, scriptHashB :: ScriptHash
scriptHashA = ScriptHash "auctionA________________________"
scriptHashB = ScriptHash "auctionB________________________"

lotSymbol :: CurrencySymbol
lotSymbol = CurrencySymbol "lotpolicy_______________________"

lotA, lotB :: TokenName
lotA = TokenName "LAPTOP"
lotB = TokenName "JUNK"

-- | Stands in for the hash of the minting policy script. In a real transaction
-- the ledger derives this from the script itself; in tests we hand it to the
-- policy through 'mintCtx'.
lotPolicy :: CurrencySymbol
lotPolicy = CurrencySymbol "lotpolicyhash___________________"

deadline :: POSIXTime
deadline = 1_700_000_000_000

-- ------------------------------------------------------------------- values

ada :: Integer -> Value
ada n = singleton adaSymbol adaToken n

lot :: TokenName -> Value
lot tn = singleton lotSymbol tn 1

-- | Bidding is only legal strictly before the deadline.
beforeDeadline :: POSIXTimeRange
beforeDeadline = to (deadline - 1_000)

-- | Payout is only legal from the deadline onwards.
afterDeadline :: POSIXTimeRange
afterDeadline = from (deadline + 1_000)

-- ------------------------------------------------------------- addresses/outs

pubKeyAddr :: PubKeyHash -> Address
pubKeyAddr pkh = Address (PubKeyCredential pkh) Nothing

scriptAddr :: ScriptHash -> Address
scriptAddr sh = Address (ScriptCredential sh) Nothing

-- | A plain payment to a wallet, no datum. The validator does not accept
-- these as settling an obligation: see 'payToFor'.
payTo :: PubKeyHash -> Value -> TxOut
payTo pkh v = TxOut (pubKeyAddr pkh) v NoOutputDatum Nothing

-- | A payment to a wallet tagged with the auction input it settles. The datum
-- is the 'TxOutRef' of the auction UTxO being spent, which is what stops one
-- output from discharging two auctions' obligations.
payToFor :: TxOutRef -> PubKeyHash -> Value -> TxOut
payToFor ref pkh v = TxOut (pubKeyAddr pkh) v (datumOf ref) Nothing

-- | An ordinary wallet input, e.g. the seed UTxO a one-shot policy consumes.
plainInput :: TxOutRef -> PubKeyHash -> Value -> TxInInfo
plainInput ref pkh v = TxInInfo ref (TxOut (pubKeyAddr pkh) v NoOutputDatum Nothing)

-- | A continuing output back to the auction script, carrying new state.
continuing :: ScriptHash -> Value -> AuctionDatum -> TxOut
continuing sh v d =
  TxOut (scriptAddr sh) v (OutputDatum (Datum (toBuiltinData d))) Nothing

datumOf :: (ToData a) => a -> OutputDatum
datumOf = OutputDatum . Datum . toBuiltinData

-- ----------------------------------------------------------------- tx pieces

txOutRefOf :: Integer -> TxOutRef
txOutRefOf i = TxOutRef (TxId "prevtx__________________________") i

-- | The auction UTxO being spent: held at the script, containing the standing
-- bid plus the lot token.
auctionInput :: TxOutRef -> ScriptHash -> TokenName -> Integer -> AuctionDatum -> TxInInfo
auctionInput ref sh tn lovelace d =
  TxInInfo ref (TxOut (scriptAddr sh) (ada lovelace <> lot tn) (datumOf d) Nothing)

params :: ScriptHash -> TokenName -> Integer -> AuctionParams
params _ tn minBid =
  AuctionParams
    { apSeller = seller
    , apCurrencySymbol = lotSymbol
    , apTokenName = tn
    , apMinBid = Lovelace minBid
    , apEndTime = deadline
    }

-- | A 'TxInfo' with every field neutral, to be overridden record-style.
emptyTxInfo :: TxInfo
emptyTxInfo =
  TxInfo
    { txInfoInputs = []
    , txInfoReferenceInputs = []
    , txInfoOutputs = []
    , txInfoFee = Lovelace 0
    , txInfoMint = emptyMintValue
    , txInfoTxCerts = []
    , txInfoWdrl = AssocMap.empty
    , txInfoValidRange = beforeDeadline
    , txInfoSignatories = []
    , txInfoRedeemers = AssocMap.empty
    , txInfoData = AssocMap.empty
    , txInfoId = TxId "thistx__________________________"
    , txInfoVotes = AssocMap.empty
    , txInfoProposalProcedures = []
    , txInfoCurrentTreasuryAmount = Nothing
    , txInfoTreasuryDonation = Nothing
    }

-- | What a transaction mints, as the ledger presents it to a policy.
mintOf :: CurrencySymbol -> [(TokenName, Integer)] -> MintValue
mintOf cs toks = UnsafeMintValue (AssocMap.unsafeFromList [(cs, AssocMap.unsafeFromList toks)])

-- | Build the context for a minting policy run. Minting scripts get no datum;
-- the 'CurrencySymbol' the policy is being run for comes via 'MintingScript'.
mintCtx :: TxInfo -> CurrencySymbol -> ScriptContext
mintCtx txInfo cs =
  ScriptContext
    { scriptContextTxInfo = txInfo
    , scriptContextRedeemer = Redeemer (toBuiltinData ())
    , scriptContextScriptInfo = MintingScript cs
    }

-- | Build the context for one script input inside a (possibly shared) tx.
ctxFor :: TxInfo -> TxOutRef -> AuctionDatum -> AuctionRedeemer -> ScriptContext
ctxFor txInfo ownRef d r =
  ScriptContext
    { scriptContextTxInfo = txInfo
    , scriptContextRedeemer = Redeemer (toBuiltinData r)
    , scriptContextScriptInfo = SpendingScript ownRef (Just (Datum (toBuiltinData d)))
    }
