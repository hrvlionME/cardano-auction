/**
 * Placing a bid.
 *
 * **The browser builds this with the command line's own code.** `bid()` is
 * imported from `off-chain/src/tx/bid.ts` unchanged — the same Plutus schemas,
 * the same parameter application, the same settlement tag. Only two things
 * differ from `deno task bid`: the wallet is a CIP-30 extension rather than a
 * seed phrase, and the provider is our own `/chain` proxy rather than
 * Blockfrost directly.
 *
 * That is worth defending out loud. A second transaction builder, in a second
 * runtime, is exactly where a datum schema quietly diverges by one constructor
 * tag — and a divergence there does not fail at build time. It fails on-chain,
 * as "failed to parse datum", after the user has paid a fee.
 *
 * Note also what the checks below are *for*. They are courtesy, not safety: a
 * bid that is too low is rejected by the validator whatever this form thinks.
 * Their job is to turn a paid, failed transaction into a disabled button.
 */
import { useEffect, useState } from "react";
import { bid as buildBid } from "@core/tx/bid.ts";
import type { AuctionSummary } from "./api.ts";
import { toAuctionState } from "./chain.ts";
import { type Connected, useSession } from "./session.tsx";
import { ada } from "./format.ts";
import { Notice, Spinner } from "./ui.tsx";

export default function BidForm(
  { auction, onDone }: { auction: AuctionSummary; onDone: (txHash: string) => void },
) {
  const { conn } = useSession();
  const floor = auction.nextBidMustExceedLovelace;
  const suggested = Math.max(floor + 1_000_000, auction.minBidLovelace);
  const [amount, setAmount] = useState(String(suggested / 1_000_000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the auction when someone else bids, unless the user has typed
  // something of their own that is still high enough to stand.
  useEffect(() => {
    setAmount((prev) =>
      Math.round(Number(prev) * 1_000_000) > floor ? prev : String(suggested / 1_000_000)
    );
  }, [floor, suggested]);

  if (auction.phase !== "bidding") return null;

  const lovelace = Math.round(Number(amount) * 1_000_000);
  const tooLow = !Number.isFinite(lovelace) ||
    (auction.bidCount > 0 ? lovelace <= floor : lovelace < auction.minBidLovelace);
  const tooRich = conn !== null && BigInt(Math.max(lovelace, 0)) > conn.balance;

  async function place(c: Connected) {
    setBusy(true);
    setError(null);
    try {
      // Re-reads the auction UTxO from the chain, re-derives the script address
      // from the parameters, checks the bid beats the standing one, and tags
      // the refund with the spent input. All of it the same code path the CLI
      // runs -- see the note above.
      const placed = await buildBid(c.lucid, toAuctionState(auction), BigInt(lovelace));
      onDone(placed.txHash);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!conn) {
    return (
      <div className="bidbox">
        <Notice kind="info">Connect a wallet to bid. No account is needed.</Notice>
      </div>
    );
  }

  return (
    <div className="bidbox">
      <div className="bidrow">
        <div className="amountfield">
          <input
            type="number"
            min={0}
            step={1}
            value={amount}
            disabled={busy}
            aria-label="Bid amount in ADA"
            onChange={(e) => setAmount(e.target.value)}
          />
          <span className="unit">₳</span>
        </div>
        <button className="btn primary" onClick={() => place(conn)} disabled={busy || tooLow || tooRich}>
          {busy ? <><Spinner /> building…</> : "Place bid"}
        </button>
      </div>
      <div className="bidmeta">
        <span>must exceed <strong>{ada(floor)} ₳</strong></span>
        <span className="dot">·</span>
        <span>
          balance <strong>{ada(conn.balance)} ₳</strong>
          {tooRich && <span className="short"> — not enough for this bid</span>}
        </span>
      </div>
      {error && <Notice kind="err">{error}</Notice>}
    </div>
  );
}
