-- | One-shot minting policy for the auction lot token.
--
-- The auction validator is parameterised by a 'CurrencySymbol' and 'TokenName'
-- naming the token that stands for the physical item. That token is only
-- meaningful if exactly one of it can ever exist -- otherwise a seller could
-- mint a second copy and the lot stops being proof of anything.
--
-- Uniqueness comes from a seed UTxO. The policy demands that one specific
-- 'TxOutRef' be consumed by the minting transaction. A UTxO can be spent only
-- once in the history of the chain, so this policy can succeed only once, and
-- the token it guards is a genuine NFT. The seed reference is a compile-time
-- parameter, so each item gets its own policy and therefore its own
-- 'CurrencySymbol'.
--
-- Burning closes the lifecycle: mint -> auction -> deliver -> burn. The lot
-- token is a bearer claim on the physical item, and burning it is the winner
-- redeeming that claim: the holder's confirmation that the item arrived. This
-- policy adds no signature requirement to a burn, because the ledger already
-- provides the one that matters -- burning means spending the UTxO that holds
-- the token, and only its owner can do that. Without a burn path the coupon
-- would live forever, and nothing on-chain would distinguish a claim already
-- redeemed from one still outstanding.
--
-- An earlier version also required the seller's signature, making the burn a
-- two-party handshake. It was dropped: a browser wallet signs only for itself,
-- so a second signature needs an off-chain relay between two people, and
-- co-signing exposes the seller -- a "burn" that also spent one of the
-- seller's UTxOs satisfied that policy just as well, since it only asked for
-- the signature.
module LotMintingPolicy where

import GHC.Generics (Generic)

import PlutusCore.Version (plcVersion110)
import PlutusLedgerApi.V3 (CurrencySymbol, PubKeyHash, ScriptContext (..), ScriptInfo (..),
                           TokenName, TxInInfo (..), TxInfo (..), TxOutRef)
import PlutusLedgerApi.V3.MintValue (mintValueToMap)
import PlutusTx
import PlutusTx.AssocMap qualified as Map
import PlutusTx.Blueprint
import PlutusTx.List qualified as List
import PlutusTx.Prelude qualified as PlutusTx

-- | Compile-time parameters, baked into the script. Changing either changes
-- the script hash, and therefore the 'CurrencySymbol' of the minted token.
data LotParams = LotParams
  { lpSeedRef   :: TxOutRef
  -- ^ The UTxO that must be spent for the mint to succeed. Spending it is what
  -- makes the mint unrepeatable.
  , lpTokenName :: TokenName
  -- ^ Name of the lot token, e.g. "LAPTOP".
  , lpSeller    :: PubKeyHash
  -- ^ Who minted the lot. No longer checked by the script, but still part of
  -- its parameters, so the policy id commits to the seller: anyone can
  -- recompute it from these three values and confirm who the lot belongs to.
  -- Keeping it also keeps the parameter encoding every off-chain tool uses.
  }
  deriving stock (Generic)
  deriving anyclass (HasBlueprintDefinition)

PlutusTx.makeLift ''LotParams
PlutusTx.makeIsDataSchemaIndexed ''LotParams [('LotParams, 0)]

{-# INLINEABLE lotTypedPolicy #-}

-- | Minting scripts receive no datum; the 'ScriptInfo' carries the
-- 'CurrencySymbol' this policy is being run for.
lotTypedPolicy :: LotParams -> ScriptContext -> Bool
lotTypedPolicy params (ScriptContext txInfo _ scriptInfo) = touchesExactlyTheLot
  where
    ownCs :: CurrencySymbol
    ownCs = case scriptInfo of
      MintingScript cs -> cs
      _                -> PlutusTx.traceError "Expected MintingScript"

    -- The whole uniqueness argument in one line: once this input is gone, no
    -- future transaction can satisfy the policy again.
    consumesSeed :: Bool
    consumesSeed =
      PlutusTx.traceIfFalse
        "Seed UTxO not consumed: this policy cannot mint again"
        ( List.any
            (\i -> txInInfoOutRef i PlutusTx.== lpSeedRef params)
            (txInfoInputs txInfo)
        )

    -- Exactly one token name under this policy, in quantity 1 (mint) or -1
    -- (burn). Checking the whole map rather than a single lookup also rules
    -- out minting extra token names alongside the lot.
    touchesExactlyTheLot :: Bool
    touchesExactlyTheLot =
      case Map.lookup ownCs (mintValueToMap (txInfoMint txInfo)) of
        Nothing -> PlutusTx.traceError "No tokens of this policy are being minted or burned"
        Just tokens -> case Map.toList tokens of
          [(tn, q)] ->
            PlutusTx.traceIfFalse
              "Wrong token name for this lot"
              (tn PlutusTx.== lpTokenName params)
              PlutusTx.&& allowedQuantity q
          _ ->
            PlutusTx.traceError "Policy must touch exactly one token name"

    -- The two legal operations, and nothing else.
    allowedQuantity :: Integer -> Bool
    allowedQuantity q =
      if q PlutusTx.== 1
        then consumesSeed
        else
          if q PlutusTx.== -1
            -- A burn needs nothing from this script. The token is in the
            -- transaction's inputs, so its owner has already signed: the
            -- ledger checks that before any script runs.
            then True
            else PlutusTx.traceError "Lot quantity must be exactly 1 (mint) or -1 (burn)"

{-# INLINEABLE lotUntypedPolicy #-}

-- | Parameters arrive as 'BuiltinData' so that off-chain tooling can apply
-- them; see 'AuctionValidator.auctionUntypedValidator' for why.
lotUntypedPolicy :: BuiltinData -> BuiltinData -> PlutusTx.BuiltinUnit
lotUntypedPolicy params ctx =
  PlutusTx.check
    ( lotTypedPolicy
        (PlutusTx.unsafeFromBuiltinData params)
        (PlutusTx.unsafeFromBuiltinData ctx)
    )

-- | The compiled policy /before/ parameters are applied; see
-- 'AuctionValidator.auctionValidatorCompiled' for why the blueprint wants this
-- rather than a pre-applied script.
lotPolicyCompiled ::
  CompiledCode (BuiltinData -> BuiltinData -> PlutusTx.BuiltinUnit)
lotPolicyCompiled = $$(PlutusTx.compile [||lotUntypedPolicy||])

-- | The policy for one specific lot, parameters baked in.
lotPolicyScript ::
  LotParams -> CompiledCode (BuiltinData -> PlutusTx.BuiltinUnit)
lotPolicyScript params =
  lotPolicyCompiled
    `PlutusTx.unsafeApplyCode` PlutusTx.liftCode plcVersion110 (PlutusTx.toBuiltinData params)
