/**
 * One auction, in full.
 *
 * The layout carries an argument. The left column is the *description* — a
 * photograph and some prose, which the operator controls and could change. The
 * right column is the *state* — reserve, standing bid, deadline, winner — every
 * figure of which came off the chain and links back to an explorer. A reader
 * who wants to know which half to trust can see the seam.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useListing } from "../data.ts";
import { useSession } from "../session.tsx";
import { ada, label, short } from "../format.ts";
import { addressUrl, tokenUrl, txUrl } from "../chain.ts";
import { Countdown, Figure, LotImage, Modal, Notice, Phase, Spinner } from "../ui.tsx";
import BidForm from "../BidForm.tsx";
import Events from "../Events.tsx";
import Settle from "../Settle.tsx";
import EditListing from "../EditListing.tsx";

export default function AuctionPage() {
  const { policyId } = useParams<{ policyId: string }>();
  const { conn, me, refreshBalance } = useSession();
  const [pending, setPending] = useState<string | null>(null);
  const [modal, setModal] = useState<{ txHash: string; what: string } | null>(null);

  const { data: a, error, refresh, vocabulary } = useListing(policyId, pending !== null);

  // The transaction has landed in the read model once the indexer has seen it.
  // In an effect rather than during render: this reads as a derived value but
  // it refreshes a wallet balance, and a side effect in a render body runs
  // again on every re-render React feels like doing.
  const landed = Boolean(pending && a?.events.some((e) => e.txHash === pending));
  useEffect(() => {
    if (!landed) return;
    setPending(null);
    void refreshBalance();
  }, [landed, refreshBalance]);

  if (error) {
    return (
      <>
        <Link className="back" to="/">← All auctions</Link>
        <Notice kind="err">{error}</Notice>
      </>
    );
  }
  if (!a) return <div className="empty">Loading…</div>;

  const you = conn?.address ?? null;
  const leading = Boolean(a.leader?.address && a.leader.address === you);
  // The same question the server asks: has this account proved control of the
  // address the compiled script will pay? Not "is this user a seller".
  const iAmSeller = Boolean(me.addresses?.includes(a.sellerAddress));
  const title = a.item?.title ?? a.tokenName;

  function done(what: string) {
    return (txHash: string) => {
      setPending(txHash);
      setModal({ txHash, what });
      void refreshBalance();
    };
  }

  return (
    <>
      <Link className="back" to="/">← All auctions</Link>

      {pending && (
        <Notice kind="info">
          <Spinner /> Waiting for{" "}
          <a href={txUrl(pending)} target="_blank" rel="noreferrer">{short(pending, 14, 8)} ↗</a>
          {" "}to reach the chain. This page updates on its own.
        </Notice>
      )}

      <div className="auction-heading">            <div className="titlerow">
              <h1 className="page-title">{title}</h1>
              <Phase phase={a.phase} />
            </div>
</div>
      <div className="detail">
        <div className="detail-left">
          <LotImage item={a.item} tokenName={a.tokenName} className="big" />
          <section className="describe panel">
            <h2>About this item</h2>
            <div className="sub mono">
              {a.tokenName}
              {" · "}
              <a href={tokenUrl(a.unit)} target="_blank" rel="noreferrer">token ↗</a>
            </div>
            {(a.item?.category || a.item?.condition) && (
              <div className="tags">
                {a.item.category && <span className="tag">{label(a.item.category)}</span>}
                {a.item.condition && <span className="tag subtle">{label(a.item.condition)}</span>}
              </div>
            )}
            {a.item?.description
              ? <p className="prose">{a.item.description}</p>
              : (
                <p className="prose dimmed">
                  The seller has not added a description for this item.
                </p>
              )}
            <div className="sub">
              Seller{" "}
              <a href={addressUrl(a.sellerAddress)} target="_blank" rel="noreferrer">
                {short(a.sellerAddress)}
              </a>
            </div>
          </section>
        </div>

        <div className="detail-right">
          <h2 className="auction-summary-title">Auction overview</h2>
          <div className="figures">
            <Figure
              label={a.phase === "settled" ? "Winning bid" : "Current bid"}
              value={a.leader ? <>{ada(a.leader.amountLovelace)}<small>₳</small></> : "--"}
              note={a.leader
                ? leading ? "yours" : a.leader.name ?? short(a.leader.address, 10, 5)
                : "no bids yet"}
            />
            <Figure
              label={a.phase === "bidding" ? "Closes in" : "Closed"}
              value={
                <span className="clock">
                  {a.phase === "bidding"
                    ? <Countdown endTime={a.endTime} />
                    : new Date(a.endTime).toLocaleDateString()}
                </span>
              }
              note={new Date(a.endTime).toLocaleString()}
            />
            <Figure label="Starting price" value={<>{ada(a.minBidLovelace)}<small>₳</small></>} />
            <Figure label="Bids" value={a.bidCount} />
          </div>

          {leading && a.phase === "bidding" && (
            <Notice kind="ok">
              You are the highest bidder. If someone outbids you, your refund is paid in the very
              transaction that displaces you — there is nothing to withdraw and nothing to claim.
            </Notice>
          )}

          <BidForm auction={a} onDone={done("Bid submitted")} />
          <Settle
            auction={a}
            lucid={conn?.lucid ?? null}
            address={conn?.address ?? null}
            onDone={done("Transaction submitted")}
          />
        </div>
      </div>

      <Events events={a.events} you={you} />

      {iAmSeller && (
        <EditListing
          policyId={a.policyId}
          tokenName={a.tokenName}
          item={a.item}
          vocabulary={vocabulary}
          onSaved={() => void refresh()}
        />
      )}

      {modal && (
        <Modal title={modal.what} onClose={() => setModal(null)}>
          <div className="tick">✓</div>
          <h2>{modal.what}</h2>
          <p>Your wallet signed it and the transaction is on its way to the chain.</p>
          <a className="txlink" href={txUrl(modal.txHash)} target="_blank" rel="noreferrer">
            {short(modal.txHash, 16, 10)} ↗
          </a>
          <p className="fine">
            It appears above once a block has been minted and the auction has been read back from
            the chain — usually under a minute. Nothing to reload.
          </p>
          <button className="btn primary" onClick={() => setModal(null)}>Done</button>
        </Modal>
      )}
    </>
  );
}
