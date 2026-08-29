-- | Emits a CIP-57 blueprint (plutus.json) for the off-chain side to build
-- transactions against.
--
-- The scripts are written *unapplied*. CIP-57 describes each script's
-- parameters separately, and off-chain applies the real ones; a pre-applied
-- script here would be applied a second time off-chain and fail at evaluation.
module Main where

import AuctionValidator
import Data.ByteString.Short qualified as Short
import Data.Set qualified as Set
import PlutusLedgerApi.Common (serialiseCompiledCode)
import LotMintingPolicy
import PlutusTx.Blueprint
import System.Environment (getArgs)

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
        let code = Short.fromShort (serialiseCompiledCode auctionValidatorCompiled)
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
        let code = Short.fromShort (serialiseCompiledCode lotPolicyCompiled)
        Just (compiledValidator PlutusV3 code)
    }

main :: IO ()
main =
  getArgs >>= \case
    [path] -> writeBlueprint path auctionContractBlueprint
    args   -> fail $ "Expects one output path, got " <> show (length args)
