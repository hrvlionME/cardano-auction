-- | Emits a CIP-57 blueprint (plutus.json) containing the compiled auction
-- validator, for the off-chain side to build transactions against.
module Main where

import AuctionValidator
import Data.ByteString.Short qualified as Short
import Data.Set qualified as Set
import PlutusLedgerApi.Common (serialiseCompiledCode)
import PlutusLedgerApi.V1.Crypto qualified as Crypto
import PlutusLedgerApi.V1.Time qualified as Time
import PlutusLedgerApi.V1.Value qualified as Value
import PlutusLedgerApi.V3 qualified as V3
import LotMintingPolicy
import PlutusTx.Blueprint
import PlutusTx.Builtins.HasOpaque (stringToBuiltinByteStringHex)
import System.Environment (getArgs)

-- | Placeholder instance. Real values get filled in per auction; changing any
-- of these changes the script hash, and therefore the script address.
auctionParams :: AuctionParams
auctionParams =
  AuctionParams
    { apSeller =
        Crypto.PubKeyHash
          ( stringToBuiltinByteStringHex
              "0000000000000000000000000000000000000000\
              \0000000000000000000000000000000000000000"
          )
    , apCurrencySymbol =
        Value.CurrencySymbol
          ( stringToBuiltinByteStringHex
              "00000000000000000000000000000000000000000000000000000000"
          )
    , apTokenName = Value.tokenName "LAPTOP"
    , apMinBid = 100
    , apEndTime = Time.fromMilliSeconds 1_725_227_091_000
    }

-- | Placeholder seed. The real one is chosen off-chain at mint time: it must
-- be a UTxO the seller actually controls, and spending it is what makes the
-- lot token unique.
lotParams :: LotParams
lotParams =
  LotParams
    { lpSeedRef =
        V3.TxOutRef
          ( V3.TxId
              ( stringToBuiltinByteStringHex
                  "0000000000000000000000000000000000000000\
                  \0000000000000000000000000000000000000000"
              )
          )
          0
    , lpTokenName = Value.tokenName "LAPTOP"
    , lpSeller = apSeller auctionParams
    }

auctionContractBlueprint :: ContractBlueprint
auctionContractBlueprint =
  MkContractBlueprint
    { contractId = Just "auction-validator"
    , contractPreamble = auctionPreamble
    , contractValidators =
        Set.fromList [auctionValidatorBlueprint, lotPolicyBlueprint]
    , contractDefinitions =
        deriveDefinitions @[AuctionParams, AuctionDatum, AuctionRedeemer, LotParams]
    }

auctionPreamble :: Preamble
auctionPreamble =
  MkPreamble
    { preambleTitle = "Auction Validator"
    , preambleDescription =
        Just "Single-UTxO English auction with same-transaction refund of the displaced bidder"
    , preambleVersion = "0.1.0"
    , preamblePlutusVersion = PlutusV3
    , preambleLicense = Just "MIT"
    }

auctionValidatorBlueprint :: ValidatorBlueprint referencedTypes
auctionValidatorBlueprint =
  MkValidatorBlueprint
    { validatorTitle = "Auction Validator"
    , validatorDescription = Just "Validates bids and payout for one auction"
    , validatorParameters =
        [ MkParameterBlueprint
            { parameterTitle = Just "Parameters"
            , parameterDescription = Just "Compile-time validator parameters"
            , parameterPurpose = Set.singleton Spend
            , parameterSchema = definitionRef @AuctionParams
            }
        ]
    , validatorRedeemer =
        MkArgumentBlueprint
          { argumentTitle = Just "Redeemer"
          , argumentDescription = Just "NewBid or Payout"
          , argumentPurpose = Set.fromList [Spend]
          , argumentSchema = definitionRef @AuctionRedeemer
          }
    , validatorDatum =
        Just
          MkArgumentBlueprint
            { argumentTitle = Just "Datum"
            , argumentDescription = Just "Highest bid so far, if any"
            , argumentPurpose = Set.fromList [Spend]
            , argumentSchema = definitionRef @AuctionDatum
            }
    , validatorCompiled = do
        let script = auctionValidatorScript auctionParams
        let code = Short.fromShort (serialiseCompiledCode script)
        Just (compiledValidator PlutusV3 code)
    }

lotPolicyBlueprint :: ValidatorBlueprint referencedTypes
lotPolicyBlueprint =
  MkValidatorBlueprint
    { validatorTitle = "Lot Minting Policy"
    , validatorDescription =
        Just "One-shot policy: mints exactly one lot token, and only by spending the seed UTxO"
    , validatorParameters =
        [ MkParameterBlueprint
            { parameterTitle = Just "Parameters"
            , parameterDescription = Just "Seed UTxO reference and lot token name"
            , parameterPurpose = Set.singleton Mint
            , parameterSchema = definitionRef @LotParams
            }
        ]
    , validatorRedeemer =
        MkArgumentBlueprint
          { argumentTitle = Just "Redeemer"
          , argumentDescription = Just "Unused; the policy's rules need no redeemer input"
          , argumentPurpose = Set.singleton Mint
          , argumentSchema = definitionRef @()
          }
    , validatorDatum = Nothing
    , validatorCompiled = do
        let script = lotPolicyScript lotParams
        let code = Short.fromShort (serialiseCompiledCode script)
        Just (compiledValidator PlutusV3 code)
    }

main :: IO ()
main =
  getArgs >>= \case
    [path] -> writeBlueprint path auctionContractBlueprint
    args   -> fail $ "Expects one output path, got " <> show (length args)
