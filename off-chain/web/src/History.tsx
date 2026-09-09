import { useEffect, useState } from "react";
import { history as fetchHistory } from "./auth.ts";
import type { HistoryRow } from "./types.ts";
import { ada } from "./api.ts";
import { txUrl } from "./chain.ts";

function status(r: HistoryRow) {
  if (r.standing && r.phase === "settled") return <span className="you">won</span>;
  if (r.standing && r.phase === "bidding") return <span className="you">leading</span>;
  if (r.standing && r.phase === "closed") return <span className="you">won, awaiting payout</span>;
  if (r.phase === "settled") return <span className="dimmed">outbid — refunded</span>;
  return <span className="dimmed">outbid — refunded</span>;
}

export default function History() {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHistory().then(setRows).catch((e) =>
      setError(e instanceof Error ? e.message : String(e))
    );
  }, []);

  if (error) return <div className="notice err">{error}</div>;
  if (rows === null) return <div className="empty">Loading history…</div>;

  const spent = rows.filter((r) => r.standing).reduce((s, r) => s + (r.amount ?? 0), 0);

  return (
    <>
      <div className="card">
        <div className="card-top"><span className="lot">Bid history</span></div>
        <p className="sub" style={{ marginTop: 4 }}>
          Reconstructed from the chain, not recorded by this site. Every row is a transaction you
          can verify on a public explorer — which is not true of a conventional auction site,
          where history is whatever the operator's database says it is.
        </p>

        {rows.length > 0 && (
          <div className="figures">
            <div className="figure">
              <div className="label">Bids placed</div>
              <div className="value">{rows.length}</div>
            </div>
            <div className="figure">
              <div className="label">Currently committed</div>
              <div className="value">{ada(spent)}<small>₳</small></div>
              <div className="note">still standing as highest</div>
            </div>
            <div className="figure">
              <div className="label">Won</div>
              <div className="value">
                {rows.filter((r) => r.standing && r.phase === "settled").length}
              </div>
            </div>
          </div>
        )}
      </div>

      {rows.length === 0
        ? (
          <div className="empty">
            No bids from your addresses yet.<br />
            <span className="sub">Place one on the Auctions tab and it will appear here.</span>
          </div>
        )
        : (
          <div className="card">
            <div className="events" style={{ marginTop: 0 }}>
              {rows.map((r) => (
                <div className="event hist" key={r.txHash}>
                  <span className="lotname">{r.tokenName}</span>
                  <span className="amt">{ada(r.amount)} ₳</span>
                  <span className="who">{status(r)}</span>
                  <a className="when" href={txUrl(r.txHash)} target="_blank" rel="noreferrer">
                    {new Date(r.blockTime * 1000).toLocaleDateString()} ↗
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
    </>
  );
}
