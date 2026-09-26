/**
 * The front page: every auction the indexer knows about.
 *
 * "Knows about" is doing real work in that sentence and the empty state says so
 * rather than hiding it. Because `AuctionParams` are compile-time parameters,
 * every auction is a different script at a different address, so there is no
 * contract to watch -- the indexer can only show auctions it was told about,
 * either by the CLI writing a state file or by a seller registering one here.
 * An auction opened by a stranger against the same source is invisible to this
 * page forever. That is the sharpest consequence of the parameterisation choice
 * and it belongs on screen, not only in a chapter.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { forDisplay, matches, useListings } from "../data.ts";
import type { Listing } from "../lots.ts";
import { ada, label } from "../format.ts";
import { Countdown, LotImage, Notice, Phase, Tags } from "../ui.tsx";

function Card({ l }: { l: Listing }) {
  const title = l.item?.title ?? l.tokenName;
  return (
    <Link className="lotcard" to={`/auction/${l.policyId}`}>
      <div className="lotcard-img">
        <LotImage item={l.item} tokenName={l.tokenName} />
        <Phase phase={l.phase} />
      </div>
      <div className="lotcard-body">
        <h3 title={title}>{title}</h3>
        <Tags item={l.item} />
        <div className="lotcard-foot">
          <div>
            <div className="label">{l.leader ? "Current bid" : "Starting price"}</div>
            <div className="price">
              {ada(l.leader?.amountLovelace ?? l.minBidLovelace)}<small>₳</small>
            </div>
          </div>
          <div className="right">
            <div className="label">{l.phase === "bidding" ? "Closes in" : "Closed"}</div>
            <div className="clock">
              {l.phase === "bidding"
                ? <Countdown endTime={l.endTime} />
                : new Date(l.endTime).toLocaleDateString()}
            </div>
          </div>
        </div>
        <div className="card-action">View auction <span aria-hidden="true">→</span></div>
      </div>
    </Link>
  );
}

export default function Browse() {
  const { data, error, categories } = useListings();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>("");

  const rows = useMemo(() => {
    if (!data) return null;
    return forDisplay(
      data.filter((l) => matches(l, q) && (!category || l.item?.category === category)),
    );
  }, [data, q, category]);

  const live = data?.filter((l) => l.phase === "bidding").length ?? 0;

  return (
    <>
      <section className="browse-heading">
        <div><span className="eyebrow">Marketplace</span><h1>Find your next great item.</h1>
          <p className="prose">Browse auctions, connect your wallet, and place your bid.</p></div>
        <Link className="btn primary" to="/sell">+ Create an auction</Link>
      </section>
      <div className="market-summary">
        <span><strong>{data ? live : "—"}</strong> live auctions</span>
        <span><strong>{data ? data.length : "—"}</strong> total listings</span>
        <span className="sub">Bids and payments secured on Cardano</span>
      </div>

      {error && (
        <Notice kind="err">
          <strong>Auctions are temporarily unavailable.</strong> Please try again shortly.
          <details><summary>Technical details</summary>{error}</details>
        </Notice>
      )}

      <div className="market-layout">
      <aside className="browse-sidebar" aria-label="Auction filters">
        <h2>Find an auction</h2>
        <label className="search-label"><span>Search</span>
        <input
          className="search"
          type="search"
          placeholder="Search auctions…"
          aria-label="Search auctions"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        </label>
        <h3>Categories</h3>
        <div className="chips">
          <button aria-pressed={category === ""} className={`chip ${category === "" ? "on" : ""}`} onClick={() => setCategory("")}>
            All items
          </button>
          {categories.map((c) => (
            <button
              key={c}
              aria-pressed={category === c}
              className={`chip ${category === c ? "on" : ""}`}
              onClick={() => setCategory(category === c ? "" : c)}
            >
              {label(c)}
            </button>
          ))}
        </div>
        <div className="sidebar-help"><strong>New to auctions?</strong><p>Choose an item to see its details, bidding deadline, and minimum bid. You approve every payment in your wallet.</p></div>
      </aside>
      <section className="market-results" aria-label="Auction results">
        <div className="section-heading"><h2>{category ? label(category) : "All auctions"}</h2>
          {rows !== null && <span className="sub" role="status">{rows.length} results</span>}
        </div>

      {rows === null && <div className="empty loading-state" role="status"><span className="spin" aria-hidden="true" /><strong>Finding your next great find</strong><p>Loading auctions…</p></div>}

      {rows !== null && rows.length === 0 && (
        <div className="empty">
          {data && data.length > 0
            ? <><strong>No matching auctions</strong><p>Try a different search or choose another category.</p></>
            : (
              <>
                <span className="empty-symbol" aria-hidden="true">₳</span>
                <strong>The next great find starts here</strong>
                <p className="sub">There are no auctions listed yet. Check back soon, or list an item of your own.</p>
                <Link className="btn primary" to="/sell">Create an auction <span aria-hidden="true">↗</span></Link>
              </>
            )}
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="grid">
          {rows.map((l) => <Card key={l.policyId} l={l} />)}
        </div>
      )}
      </section>
      </div>
    </>
  );
}

