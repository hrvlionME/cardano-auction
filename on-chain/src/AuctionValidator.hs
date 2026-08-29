-- | On-chain validator for a single-UTxO English auction.
--
-- Design (see thesis ch. 3): the auction lives in exactly one script UTxO.
-- Each bid spends that UTxO and recreates it with updated state, refunding the
-- previous highest bidder in the same transaction. Because a losing bid is
-- returned the instant it is beaten, no bid-withdrawal path is needed: at any
-- moment the only locked funds belong to the current highest bidder, who must
-- not be allowed to withdraw anyway.
module AuctionValidator where

import GHC.Generics (Generic)

import PlutusCore.Version (plcVersion110)
import PlutusLedgerApi.V1.Address (toPubKeyHash)
import PlutusLedgerApi.V1.Interval (contains)
import PlutusLedgerApi.V1.Value (lovelaceValueOf, valueOf)
import PlutusLedgerApi.V3 (CurrencySymbol, Datum (..), Lovelace, OutputDatum (..), POSIXTime,
                           PubKeyHash, Redeemer (..), ScriptContext (..), ScriptInfo (..),
                           TokenName, TxInfo (..), TxOut (..), TxOutRef, from, getRedeemer, to)
import PlutusLedgerApi.V3.Contexts (getContinuingOutputs)
import PlutusTx
import PlutusTx.Blueprint
import PlutusTx.Builtins qualified as Builtins
import PlutusTx.List qualified as List
import PlutusTx.Prelude qualified as PlutusTx
import PlutusTx.Show qualified as PlutusTx

-- | Compile-time parameters. These are baked into the script, so each auction
-- instance gets its own script address.
data AuctionParams = AuctionParams
  { apSeller         :: PubKeyHash
  -- ^ Receives the winning bid, or the lot back if nobody bids.
  , apCurrencySymbol :: CurrencySymbol
  -- ^ Currency symbol of the lot token (the NFT standing for the laptop).
  , apTokenName      :: TokenName
  -- ^ Token name of the lot token.
  , apMinBid         :: Lovelace
  -- ^ Reserve price, in Lovelace.
  , apEndTime        :: POSIXTime
  -- ^ Bidding closes at this time; payout may happen from this time on.
  }
  deriving stock (Generic)
  deriving anyclass (HasBlueprintDefinition)

PlutusTx.makeLift ''AuctionParams
PlutusTx.makeIsDataSchemaIndexed ''AuctionParams [('AuctionParams, 0)]

data Bid = Bid
  { bPkh    :: PubKeyHash
  -- ^ Bidder's public key hash; refunds and the lot are paid here.
  , bAmount :: Lovelace
  -- ^ Bid amount in Lovelace.
  }
  deriving stock (Generic)
  deriving anyclass (HasBlueprintDefinition)

PlutusTx.deriveShow ''Bid
PlutusTx.makeIsDataSchemaIndexed ''Bid [('Bid, 0)]

instance PlutusTx.Eq Bid where
  {-# INLINEABLE (==) #-}
  b == b' =
    bPkh b PlutusTx.== bPkh b'
      PlutusTx.&& bAmount b PlutusTx.== bAmount b'

-- | The whole auction state: the highest bid so far, if any.
newtype AuctionDatum = AuctionDatum {adHighestBid :: Maybe Bid}
  deriving stock (Generic)
  deriving newtype
    ( HasBlueprintDefinition
    , PlutusTx.ToData
    , PlutusTx.FromData
    , PlutusTx.UnsafeFromData
    )

-- | Either raise the auction, or settle it once the deadline has passed.
data AuctionRedeemer = NewBid Bid | Payout
  deriving stock (Generic)
  deriving anyclass (HasBlueprintDefinition)

PlutusTx.makeIsDataSchemaIndexed ''AuctionRedeemer [('NewBid, 0), ('Payout, 1)]

{-# INLINEABLE auctionTypedValidator #-}

-- | PlutusV3 hands the script a single argument: the 'ScriptContext', which
-- carries the redeemer and (for spending scripts) the datum.
auctionTypedValidator :: AuctionParams -> ScriptContext -> Bool
auctionTypedValidator params ctx@(ScriptContext txInfo scriptRedeemer scriptInfo) =
  List.and conditions
  where
    redeemer :: AuctionRedeemer
    redeemer = case PlutusTx.fromBuiltinData (getRedeemer scriptRedeemer) of
      Nothing -> PlutusTx.traceError "Failed to parse AuctionRedeemer"
      Just r  -> r

    highestBid :: Maybe Bid
    highestBid = case scriptInfo of
      SpendingScript _ (Just (Datum datum)) ->
        case PlutusTx.fromBuiltinData datum of
          Just (AuctionDatum bid) -> bid
          Nothing                 -> PlutusTx.traceError "Failed to parse AuctionDatum"
      _ -> PlutusTx.traceError "Expected SpendingScript with datum"

    -- The particular auction UTxO whose spending this run is authorising.
    -- Every obligation below is anchored to it; see 'settlesThisAuction'.
    ownRef :: TxOutRef
    ownRef = case scriptInfo of
      SpendingScript oref _ -> oref
      _                     -> PlutusTx.traceError "Expected SpendingScript"

    -- The fix for double satisfaction.
    --
    -- Each obligation used to be discharged by asking the transaction at
    -- large "is there an output paying X this much?". Two auction UTxOs spent
    -- in one transaction would both find the /same/ output and both accept,
    -- so a single payment settled two debts and the difference went to the
    -- attacker as change.
    --
    -- An output now counts towards this auction only if it carries this
    -- input's 'TxOutRef' as its datum. A 'TxOutRef' identifies one input of
    -- one transaction, so no output can answer for two auctions at once.
    -- Honest batching is unaffected: settle each auction with its own output
    -- and tag each output with the input it settles.
    settlesThisAuction :: TxOut -> Bool
    settlesThisAuction o = case txOutDatum o of
      OutputDatum (Datum d) -> Builtins.equalsData d (PlutusTx.toBuiltinData ownRef)
      _                     -> False

    conditions :: [Bool]
    conditions = case redeemer of
      NewBid bid ->
        [ sufficientBid bid
        , validBidTime
        , refundsPreviousHighestBid
        , correctOutput bid
        ]
      Payout ->
        [ validPayoutTime
        , sellerGetsHighestBid
        , highestBidderGetsAsset
        ]

    -- A bid must beat the standing bid, or clear the reserve if it is the first.
    sufficientBid :: Bid -> Bool
    sufficientBid (Bid _ amt) = case highestBid of
      Just (Bid _ amt') -> amt PlutusTx.> amt'
      Nothing           -> amt PlutusTx.>= apMinBid params

    -- The whole validity range must sit before the deadline, so the bid cannot
    -- possibly land after close.
    validBidTime :: Bool
    ~validBidTime = to (apEndTime params) `contains` txInfoValidRange txInfo

    -- The heart of the design: whoever is being displaced gets paid back now.
    refundsPreviousHighestBid :: Bool
    ~refundsPreviousHighestBid = case highestBid of
      Nothing -> True
      Just (Bid bidderPkh amt) ->
        case List.find
          ( \o ->
              (toPubKeyHash (txOutAddress o) PlutusTx.== Just bidderPkh)
                PlutusTx.&& (lovelaceValueOf (txOutValue o) PlutusTx.== amt)
                PlutusTx.&& settlesThisAuction o
          )
          (txInfoOutputs txInfo) of
          Just _  -> True
          Nothing ->
            PlutusTx.traceError "Not found: refund output tagged with this auction's input"

    currencySymbol :: CurrencySymbol
    currencySymbol = apCurrencySymbol params

    tokenName :: TokenName
    tokenName = apTokenName params

    -- Exactly one continuing output, holding the lot plus the new bid, with a
    -- datum naming that bid as the new high.
    correctOutput :: Bid -> Bool
    correctOutput bid = case getContinuingOutputs ctx of
      [o] ->
        let correctOutputDatum = case txOutDatum o of
              OutputDatum (Datum newDatum) -> case PlutusTx.fromBuiltinData newDatum of
                Just (AuctionDatum (Just bid')) ->
                  PlutusTx.traceIfFalse
                    "Invalid output datum: contains a different Bid than expected"
                    (bid PlutusTx.== bid')
                Just (AuctionDatum Nothing) ->
                  PlutusTx.traceError "Invalid output datum: expected Just Bid, got Nothing"
                Nothing ->
                  PlutusTx.traceError "Failed to decode output datum"
              OutputDatumHash _ ->
                PlutusTx.traceError "Expected OutputDatum, got OutputDatumHash"
              NoOutputDatum ->
                PlutusTx.traceError "Expected OutputDatum, got NoOutputDatum"

            outValue = txOutValue o

            correctOutputValue =
              (lovelaceValueOf outValue PlutusTx.== bAmount bid)
                PlutusTx.&& (valueOf outValue currencySymbol tokenName PlutusTx.== 1)
         in correctOutputDatum PlutusTx.&& correctOutputValue
      os ->
        PlutusTx.traceError
          ( "Expected exactly one continuing output, got "
              PlutusTx.<> PlutusTx.show (List.length os)
          )

    validPayoutTime :: Bool
    ~validPayoutTime = from (apEndTime params) `contains` txInfoValidRange txInfo

    sellerGetsHighestBid :: Bool
    ~sellerGetsHighestBid = case highestBid of
      Nothing -> True
      Just bid ->
        case List.find
          ( \o ->
              (toPubKeyHash (txOutAddress o) PlutusTx.== Just (apSeller params))
                PlutusTx.&& (lovelaceValueOf (txOutValue o) PlutusTx.== bAmount bid)
                PlutusTx.&& settlesThisAuction o
          )
          (txInfoOutputs txInfo) of
          Just _  -> True
          Nothing ->
            PlutusTx.traceError "Not found: seller output tagged with this auction's input"

    highestBidderGetsAsset :: Bool
    ~highestBidderGetsAsset =
      let highestBidder = case highestBid of
            Nothing  -> apSeller params -- no bids: the lot goes home
            Just bid -> bPkh bid
       in case List.find
            ( \o ->
                (toPubKeyHash (txOutAddress o) PlutusTx.== Just highestBidder)
                  PlutusTx.&& (valueOf (txOutValue o) currencySymbol tokenName PlutusTx.== 1)
                  PlutusTx.&& settlesThisAuction o
            )
            (txInfoOutputs txInfo) of
            Just _  -> True
            Nothing ->
              PlutusTx.traceError "Not found: lot output tagged with this auction's input"

{-# INLINEABLE auctionUntypedValidator #-}

-- | Note that the parameters arrive as 'BuiltinData' and are decoded here,
-- rather than being taken as an 'AuctionParams' argument directly.
--
-- This is what lets off-chain tooling apply the parameters. 'liftCode' would
-- bake them in using Plutus Core's native representation, but every off-chain
-- library applies parameters as 'Data'. If the script expected the native form
-- and received 'Data', it would try to case on a constant and fail at
-- evaluation. Taking 'BuiltinData' makes both sides agree.
auctionUntypedValidator :: BuiltinData -> BuiltinData -> PlutusTx.BuiltinUnit
auctionUntypedValidator params ctx =
  PlutusTx.check
    ( auctionTypedValidator
        (PlutusTx.unsafeFromBuiltinData params)
        (PlutusTx.unsafeFromBuiltinData ctx)
    )

-- | The compiled script /before/ parameters are applied.
--
-- This is what belongs in the blueprint. CIP-57 describes a script's
-- parameters separately from its compiled code, so the off-chain side applies
-- the real ones. Publishing a pre-applied script instead means off-chain
-- applies parameters a second time, and the script then receives its own
-- parameters where it expects a ScriptContext.
auctionValidatorCompiled ::
  CompiledCode (BuiltinData -> BuiltinData -> PlutusTx.BuiltinUnit)
auctionValidatorCompiled = $$(PlutusTx.compile [||auctionUntypedValidator||])

-- | The script for one specific auction, parameters baked in.
auctionValidatorScript ::
  AuctionParams -> CompiledCode (BuiltinData -> PlutusTx.BuiltinUnit)
auctionValidatorScript params =
  auctionValidatorCompiled
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCode plcVersion110 (PlutusTx.toBuiltinData params)
