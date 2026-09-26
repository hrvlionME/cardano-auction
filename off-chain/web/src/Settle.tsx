import { useEffect, useState } from "react";
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
 * **Claim** is the burn -- the winner's confirmation that the item arrived.
 * Only the holder of the token can burn it, so only the holder is offered the
 * button: the winner, or the seller when nobody bid and the lot came home.
 */
export default function Settle({ auction, lucid, address, onDone }: Props) {
  const [busy, setBusy] = useState<"settle" | "claim" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [burned, setBurned] = useState<boolean | null>(null);

  // Whether the token still exists, asked of the chain through our proxy. The
  // indexer does not see a burn -- it happens in the holder's wallet, not at
  // the auction address -- so without this a redeemed lot would keep offering
  // a button that can only fail. Re-asked whenever a transaction finishes.
  const settled = auction.phase === "settled";
  useEffect(() => {
    if (!settled) return;
    let live = true;
    fetch(`/chain/assets/${auction.unit}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((a: { quantity: string } | null) => {
        if (live) setBurned(a ? a.quantity === "0" : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [settled, auction.unit, busy]);

  if (auction.phase === "bidding") return null;

  // Who holds the token after settlement: the winner, or the seller if nobody
  // bid. Compared by payment key, which is what signs.
  const myPkh = address ? paymentCredentialOf(address).hash : null;
  const holderPkh = auction.leader?.address
    ? paymentCredentialOf(auction.leader.address).hash
    : auction.lot?.sellerPkh ?? null;
  const iHoldIt = myPkh !== null && myPkh === holderPkh;

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
        onDone((await claim(lucid, lot)).txHash);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function burnPanel() {
    if (burned) {
      return (
        <div className="notice ok">
          Handed over. The lot token has been burned, so the claim is redeemed and can never be
          used again — and anyone can check that on the chain.
        </div>
      );
    }
    if (iHoldIt) {
      return (
        <>
          <div className="bidrow">
            <button className="primary" onClick={() => run("claim")} disabled={!lucid || busy !== null}>
              {busy === "claim" ? <><span className="spin" /> burning…</> : "Claim item (burn token)"}
            </button>
            <span className="sub">Confirms the item is in your hands.</span>
          </div>
          <div className="balance">
            {auction.leader
              ? "Press this once you have received the item. Burning the token is your receipt: it tells the seller, and anyone else who looks, that the handover is done. It cannot be undone."
              : "Nobody bid, so the lot came back to you. Burning it retires the token for good."}
          </div>
        </>
      );
    }
    return (
      <div className="notice info">
        {auction.leader
          ? "Settled. The winner holds the lot token and burns it once the item has arrived."
          : "Settled with no bids. The lot token went back to the seller."}
      </div>
    );
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

      {settled && auction.lot && burnPanel()}

      {!lucid && auction.phase === "closed" && (
        <div className="notice info">Connect a wallet to settle this auction.</div>
      )}
      {error && <div className="notice err">{error}</div>}
    </div>
  );
}
