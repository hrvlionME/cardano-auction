/**
 * An auction's history, reconstructed from the chain.
 *
 * Every row here corresponds to a transaction anyone can look up on a public
 * explorer, which is the difference worth pointing at: on a conventional
 * auction site the bid history is whatever the operator's database says, and
 * the only way to check it is to ask the operator. Here the database is a
 * cache, `deno task db:reset` throws it away and rebuilds it from the ledger,
 * and every line carries the link that proves it.
 *
 * Events are classified by transaction *shape* rather than by redeemer: an
 * output at the address with no input from it is an open, an input with an
 * output back is a bid, an input with no output back is a settle.
 */
import type { AuctionEvent } from "./api.ts";
import { ada, short } from "./format.ts";
import { txUrl } from "./chain.ts";

const WHAT: Record<AuctionEvent["kind"], string> = {
  open: "opened",
  bid: "bid",
  settle: "settled",
};

export default function Events({ events, you }: { events: AuctionEvent[]; you: string | null }) {
  if (events.length === 0) return null;

  return (
    <section className="panel">
      <h3>
        History <span className="sub">from the chain, not from our records</span>
      </h3>
      <ol className="events">
        {[...events].reverse().map((e) => (
          <li className="event" key={e.txHash}>
            <span className={`kind ${e.kind}`}>{WHAT[e.kind]}</span>
            <span className="amt">
              {e.amountLovelace === null ? "" : <>{ada(e.amountLovelace)} ₳</>}
            </span>
            <span className="who">
              {e.bidderAddress && (
                <span
                  className={e.bidderAddress === you ? "you" : e.bidderName ? "named" : "dimmed"}
                  title={e.bidderAddress}
                >
                  {e.bidderAddress === you ? "you" : e.bidderName ?? short(e.bidderAddress, 14, 6)}
                </span>
              )}
            </span>
            <a className="when" href={txUrl(e.txHash)} target="_blank" rel="noreferrer">
              {new Date(e.at).toLocaleString()} ↗
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
