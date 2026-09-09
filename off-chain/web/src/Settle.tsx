import { useState } from "react";
import { paymentCredentialOf } from "@lucid-evolution/lucid";
import { payout } from "@core/tx/payout.ts";
import { claim } from "@core/tx/claim.ts";
import { toAuctionState, toLotState, txUrl } from "./chain.ts";
import type { AuctionSummary } from "./api.ts";

type Lucid = Parameters<typeof payout>[0];

interface Props {
  auction: AuctionSummary;
  lucid: Lucid | null;
  address: string | null;
  onDone: (txHash: string) => void;
}

/**
 * The two transactions that end an auction's life, once bidding is over.
 *
 * **Settle** is the one that matters, and the reason it needs a button at all
 * is worth stating: a blockchain has no scheduler. A validator is a predicate
 * that runs only when someone tries to spend the UTxO -- it cannot wake up when
 * a deadline passes. So a finished auction sits there, correct and unsettled,
 * until somebody submits the transaction. The validator does not care who: it
 * checks the seller is paid exactly the winning bid and the lot goes to the
 * winner, and is indifferent to whose wallet paid the fee.
 *
 * The contract therefore guarantees *safety* (if it happens, it is right) and
 * not *liveness* (that it happens at all). This button is one answer to
 * liveness that costs nothing in trust, because whoever clicks it still cannot
 * make the transaction do anything the validator would reject.
 *
 * **Claim** is the burn -- the receipt for handing the physical item over. It
 * needs two signatures, the holder's and the seller's, so the browser can only
 * offer it when one person is both. See the note rendered below for why that
 * is a finding rather than an omission.
 */
export default function Settle({ auction, lucid, address, onDone }: Props) {
  const [busy, setBusy] = useState<"settle" | "claim" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (auction.phase === "bidding") return null;

  const myPkh = address ? paymentCredentialOf(address).hash : null;
  const iAmSeller = myPkh !== null && auction.lot !== null &&
    myPkh === auction.lot.sellerPkh;

  async function run(what: "settle" | "claim") {
    if (!lucid) return;
    setBusy(what);
    setError(null);
    try {
      if (what === "settle") {
        onDone((await payout(lucid, toAuctionState(auction))).txHash);
      } else {
        const lot = toLotState(auction);
        if (!lot) throw new Error("This lot's minting parameters are not recorded.");
        onDone((await claim(lucid, lot, {})).txHash);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bidbox">
      {auction.phase === "closed" && (
        <>
          <div className="bidrow">
            <button className="primary" onClick={() => run("settle")} disabled={!lucid || busy !== null}>
              {busy === "settle" ? <><span className="spin" /> settling…</> : "Settle auction"}
            </button>
            <span className="sub">
              {auction.leader
                ? "Pays the seller and delivers the lot to the winner."
                : "No bids — returns the lot to the seller."}
            </span>
          </div>
          <div className="balance">
            Bidding is over, but nothing moves on its own: a blockchain has no scheduler, so a
            validator only runs when someone submits a transaction. Anyone may settle this — the
            validator checks the amounts, not who sent them. Whoever does pays the fee.
          </div>
        </>
      )}

      {auction.phase === "settled" && auction.lot && (
        iAmSeller
          ? (
            <>
              <div className="bidrow">
                <button className="primary" onClick={() => run("claim")} disabled={!lucid || busy !== null}>
                  {busy === "claim" ? <><span className="spin" /> burning…</> : "Claim item (burn token)"}
                </button>
                <span className="sub">Marks the item as handed over.</span>
              </div>
              <div className="balance">
                Burning needs the holder's signature and the seller's. You are both here, so one
                signature covers it.
              </div>
            </>
          )
          : (
            <div className="notice info">
              Settled. The winner holds the lot token.
              {"\n\n"}Burning it — the receipt for handing the item over — needs two signatures,
              the holder's and the seller's, on one transaction. That is a protocol between two
              people rather than a button, so this interface does not offer it. The command line
              does, with both keys present: <code>deno task claim</code>.
            </div>
          )
      )}

      {!lucid && auction.phase === "closed" && (
        <div className="notice info">Connect a wallet to settle this auction.</div>
      )}
      {error && <div className="notice err">{error}</div>}
    </div>
  );
}
