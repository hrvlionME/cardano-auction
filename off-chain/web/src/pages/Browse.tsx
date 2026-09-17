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
import { useSession } from "../session.tsx";

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
        {l.item?.title && <div className="sub mono">{l.tokenName}</div>}
        <Tags item={l.item} />
        <div className="lotcard-foot">
          <div>
            <div className="label">{l.leader ? "Standing bid" : "Reserve"}</div>
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
      </div>
    </Link>
  );
}

export default function Browse() {
  const { data, error, categories } = useListings();
  const { me } = useSession();
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
      <section className="hero">
        <div>
          <h2>Auctions</h2>
          <p>
            Bids are held by a Plutus validator, not by this site. Nobody here — including
            whoever runs it — can seize a bid, alter a result, or settle an auction in a way the
            script would reject. Every figure below links to a public explorer so you can check
            it against the chain rather than trusting the page.
          </p>
        </div>
        {data && (
          <div className="herostats">
            <div>
              <strong>{live}</strong>
              <span>live now</span>
            </div>
            <div>
              <strong>{data.length}</strong>
              <span>indexed</span>
            </div>
          </div>
        )}
      </section>

      {error && (
        <Notice kind="err">
          Could not reach the indexer: {error}
          {"\n"}Is it running? cd off-chain && deno task serve --sync
        </Notice>
      )}

      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="Search lots…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="chips">
          <button className={`chip ${category === "" ? "on" : ""}`} onClick={() => setCategory("")}>
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              className={`chip ${category === c ? "on" : ""}`}
              onClick={() => setCategory(category === c ? "" : c)}
            >
              {label(c)}
            </button>
          ))}
        </div>
        {me.user && <Link className="btn primary" to="/sell">Sell an item</Link>}
      </div>

      {rows === null && <div className="empty">Loading…</div>}

      {rows !== null && rows.length === 0 && (
        <div className="empty">
          {data && data.length > 0
            ? <>Nothing matches that search.</>
            : (
              <>
                <strong>No auctions indexed yet.</strong>
                <p className="sub">
                  Every auction compiles to its own script at its own address, so there is no
                  single contract to watch — the indexer only sees auctions it has been told
                  about. Open one {me.user ? <Link to="/sell">here</Link> : "by signing in"}, or
                  from the command line with <code>deno task open-auction</code>.
                </p>
              </>
            )}
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="grid">
          {rows.map((l) => <Card key={l.policyId} l={l} />)}
        </div>
      )}
    </>
  );
}

