import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ada,
  type AuctionDetail,
  type AuctionEvent,
  type AuctionSummary,
  getAuction,
  listAuctions,
} from "./api.ts";
import { addressUrl, isTestnet, makeBrowserLucid, toAuctionState, tokenUrl, txUrl } from "./chain.ts";
import { availableWallets, type AvailableWallet, connect, WalletError, type WalletApi } from "./wallet.ts";
import { bid as buildBid } from "@core/tx/bid.ts";
import { me as fetchMe, signIn, signOut } from "./auth.ts";
import Profile from "./Profile.tsx";
import History from "./History.tsx";
import SettleBox from "./Settle.tsx";
import type { Me } from "./types.ts";

/**
 * How often the page re-reads the API.
 *
 * Faster while a bid is in flight, because that is the one moment someone is
 * actually waiting on it. The rest of the time an auction changes every few
 * minutes at most and there is nothing to gain from asking more often.
 */
const POLL_MS = 8_000;
const POLL_MS_PENDING = 3_000;

type Lucid = Awaited<ReturnType<typeof makeBrowserLucid>>;

/* ------------------------------------------------------------------ wallet */

interface Connected {
  api: WalletApi;
  lucid: Lucid;
  address: string;
  balance: bigint;
}

/** Sum the lovelace the connected wallet can actually spend. */
async function readBalance(lucid: Lucid): Promise<bigint> {
  const utxos = await lucid.wallet().getUtxos();
  return utxos.reduce((sum, u) => sum + (u.assets.lovelace ?? 0n), 0n);
}

function useWallet() {
  const [wallets, setWallets] = useState<AvailableWallet[]>([]);
  const [conn, setConn] = useState<Connected | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Extensions inject themselves as the page loads, so a single read on mount
  // reports "no wallet installed" for a browser that has one. Poll briefly.
  useEffect(() => {
    let tries = 0;
    const id = setInterval(() => {
      const found = availableWallets();
      if (found.length > 0 || ++tries > 10) {
        setWallets(found);
        clearInterval(id);
      }
    }, 300);
    setWallets(availableWallets());
    return () => clearInterval(id);
  }, []);

  const link = useCallback(async (key: string): Promise<Connected | null> => {
    setBusy(true);
    setError(null);
    try {
      const api = await connect(key, isTestnet);
      const lucid = await makeBrowserLucid(api);
      const address = await lucid.wallet().address();
      const next = { api, lucid, address, balance: await readBalance(lucid) };
      setConn(next);
      return next;
    } catch (e) {
      setError(
        e instanceof WalletError
          ? e.message
          : `Could not connect: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  // Held in a ref as well as in state so `refreshBalance` can stay a stable
  // callback: it is a dependency of the polling effect, and rebuilding it on
  // every balance change would tear the interval down and rebuild it each time.
  const connRef = useRef<Connected | null>(null);
  connRef.current = conn;

  /** Re-read the balance: it changes when a bid is placed, and when one is refunded. */
  const refreshBalance = useCallback(async () => {
    const current = connRef.current;
    if (!current) return;
    try {
      const balance = await readBalance(current.lucid);
      setConn((c) => (c && c.address === current.address ? { ...c, balance } : c));
    } catch {
      // A balance that fails to refresh is a stale number on screen, not a
      // reason to interrupt anything. The next poll tries again.
    }
  }, []);

  return { wallets, conn, busy, error, link, refreshBalance, disconnect: () => setConn(null) };
}

/* ------------------------------------------------------------------ pieces */

function short(addr: string | null, head = 12, tail = 6): string {
  if (!addr) return "--";
  return addr.length <= head + tail + 1 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

function Countdown({ endTime }: { endTime: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const left = endTime - now;
  if (left <= 0) return <>closed</>;
  const s = Math.floor(left / 1000);
  const d = Math.floor(s / 86400);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(Math.floor(s % 86400 / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
  return <>{d > 0 ? `${d}d ${clock}` : clock}</>;
}

function Events({ events, you }: { events: AuctionEvent[]; you: string | null }) {
  if (events.length === 0) return null;
  return (
    <div className="events">
      <h3>History, from the chain</h3>
      {events.map((e) => (
        <div className="event" key={e.txHash}>
          <span className={`kind ${e.kind}`}>{e.kind}</span>
          <span className="amt">{e.amountLovelace === null ? "" : `${ada(e.amountLovelace)} ₳`}</span>
          <span className="who">
            {e.bidderAddress
              ? (
                <span
                  className={e.bidderAddress === you ? "you" : e.bidderName ? "named" : undefined}
                  title={e.bidderAddress}
                >
                  {e.bidderAddress === you
                    ? "you"
                    : e.bidderName ?? short(e.bidderAddress, 16, 8)}
                </span>
              )
              : ""}
          </span>
          <a className="when" href={txUrl(e.txHash)} target="_blank" rel="noreferrer">
            {new Date(e.at).toLocaleTimeString()} ↗
          </a>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- modal */

function SuccessModal({ txHash, onClose }: { txHash: string; onClose: () => void }) {
  // Escape closes it, which is what anyone will try first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="tick">✓</div>
        <h2>Bid submitted</h2>
        <p>
          Your wallet signed it and the transaction is on its way to the chain.
        </p>
        <a className="txlink" href={txUrl(txHash)} target="_blank" rel="noreferrer">
          {short(txHash, 16, 10)} ↗
        </a>
        <p className="fine">
          It will appear below once a block has been minted and the auction has been read back
          from the chain — usually under a minute. Nothing to reload.
        </p>
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- bid form */

function BidForm(
  { auction, conn, onDone }: {
    auction: AuctionSummary;
    conn: Connected | null;
    onDone: (txHash: string) => void;
  },
) {
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

  const lovelace = Math.round(Number(amount) * 1_000_000);
  const tooLow = !Number.isFinite(lovelace) ||
    (auction.bidCount > 0 ? lovelace <= floor : lovelace < auction.minBidLovelace);
  const tooRich = conn !== null && BigInt(Math.max(lovelace, 0)) > conn.balance;

  async function place() {
    if (!conn) return;
    setBusy(true);
    setError(null);
    try {
      // The CLI's own bid builder. It re-reads the auction UTxO from the chain,
      // re-derives the script address from the parameters, checks the bid
      // beats the standing one, and tags the refund with the spent input --
      // all of it the same code path `deno task bid` runs.
      const placed = await buildBid(conn.lucid, toAuctionState(auction), BigInt(lovelace));
      onDone(placed.txHash);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (auction.phase !== "bidding") return null;

  return (
    <div className="bidbox">
      {!conn
        ? <div className="notice info">Connect a wallet to bid.</div>
        : (
          <>
            <div className="bidrow">
              <input
                type="number"
                min={0}
                step={1}
                value={amount}
                disabled={busy}
                onChange={(e) => setAmount(e.target.value)}
              />
              <span className="unit">ADA</span>
              <button className="primary" onClick={place} disabled={busy || tooLow || tooRich}>
                {busy ? <><span className="spin" /> building…</> : "Place bid"}
              </button>
              <span className="sub">must exceed {ada(floor)} ₳</span>
            </div>
            <div className="balance">
              Balance <strong>{ada(conn.balance)} ₳</strong>
              {tooRich && <span className="short"> — not enough for this bid</span>}
            </div>
          </>
        )}
      {error && <div className="notice err">{error}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

function Detail(
  { auction, events, conn, onBid }: {
    auction: AuctionSummary;
    events: AuctionEvent[];
    conn: Connected | null;
    onBid: (h: string) => void;
  },
) {
  const you = conn?.address ?? null;
  const leading = auction.leader?.address && auction.leader.address === you;

  return (
    <div className="card">
      <div className="card-top">
        <span className="lot">{auction.tokenName}</span>
        <span className={`phase ${auction.phase}`}>{auction.phase}</span>
        <span style={{ flex: 1 }} />
        <a className="sub" href={tokenUrl(auction.unit)} target="_blank" rel="noreferrer">token ↗</a>
      </div>

      <div className="sub">
        Seller{" "}
        <a href={addressUrl(auction.sellerAddress)} target="_blank" rel="noreferrer">
          {short(auction.sellerAddress)}
        </a>
      </div>

      <div className="figures">
        <div className="figure">
          <div className="label">Reserve</div>
          <div className="value">{ada(auction.minBidLovelace)}<small>₳</small></div>
        </div>
        <div className="figure">
          <div className="label">{auction.phase === "settled" ? "Winning bid" : "Standing bid"}</div>
          <div className="value">
            {auction.leader ? <>{ada(auction.leader.amountLovelace)}<small>₳</small></> : "--"}
          </div>
          <div className="note" title={auction.leader?.address ?? undefined}>
            {auction.leader
              ? leading
                ? "yours"
                : auction.leader.name ?? short(auction.leader.address, 10, 5)
              : "no bids yet"}
          </div>
        </div>
        <div className="figure">
          <div className="label">{auction.phase === "bidding" ? "Closes in" : "Closed"}</div>
          <div className="value" style={{ fontVariantNumeric: "tabular-nums" }}>
            {auction.phase === "bidding"
              ? <Countdown endTime={auction.endTime} />
              : new Date(auction.endTime).toLocaleDateString()}
          </div>
          <div className="note">{new Date(auction.endTime).toLocaleString()}</div>
        </div>
        <div className="figure">
          <div className="label">Bids</div>
          <div className="value">{auction.bidCount}</div>
        </div>
      </div>

      {leading && auction.phase === "bidding" && (
        <div className="notice ok">
          You are the highest bidder. If someone outbids you, the refund is paid in the very
          transaction that displaces you — there is nothing to withdraw and nothing to claim.
        </div>
      )}

      <BidForm auction={auction} conn={conn} onDone={onBid} />
      <SettleBox
        auction={auction}
        lucid={conn?.lucid ?? null}
        address={conn?.address ?? null}
        onDone={onBid}
      />
      <Events events={events} you={you} />
    </div>
  );
}

/* -------------------------------------------------------------------- app */

export default function App() {
  const { wallets, conn, busy, error: walletError, link, refreshBalance, disconnect } = useWallet();
  const [auctions, setAuctions] = useState<AuctionSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuctionDetail | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [modal, setModal] = useState<string | null>(null);
  const [me, setMe] = useState<Me>({ user: null });
  const [view, setView] = useState<"auctions" | "history" | "profile">("auctions");
  const [welcome, setWelcome] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  // An existing session survives a reload, so ask before doing anything else.
  useEffect(() => {
    fetchMe().then((m) => setMe(m ?? { user: null })).catch(() => {});
  }, []);

  /**
   * Connect, then offer to sign in.
   *
   * Two wallet prompts in a row, and the second is optional: refusing it leaves
   * the wallet connected and bidding fully available, because bidding is a
   * transaction the chain validates and this server is not consulted. An
   * account only adds what the chain deliberately does not know.
   */
  const connectAndSignIn = useCallback(async (key: string) => {
    const c = await link(key);
    if (!c) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      const result = await signIn(c.lucid);
      setMe(result);
      if (result.isNew) {
        setWelcome(true);
        setView("profile");
      }
    } catch (e) {
      // Declining the signature is a legitimate choice and stays silent -- the
      // wallet is connected and bidding works without an account. Anything
      // else is a real fault and must be visible: swallowing it once meant a
      // misconfigured dev proxy looked exactly like a user saying no.
      const msg = e instanceof Error ? e.message : String(e);
      const declined = /declin|reject|denied|cancel|user|refus/i.test(msg);
      if (!declined) setSignInError(`Could not sign in: ${msg}`);
    } finally {
      setSigningIn(false);
    }
  }, [link]);

  /** Sign in with an already-connected wallet. */
  const signInAgain = useCallback(async () => {
    if (!conn) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      const result = await signIn(conn.lucid);
      setMe(result);
      if (result.isNew) {
        setWelcome(true);
        setView("profile");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const declined = /declin|reject|denied|cancel|user|refus/i.test(msg);
      if (!declined) setSignInError(`Could not sign in: ${msg}`);
    } finally {
      setSigningIn(false);
    }
  }, [conn]);

  const leave = useCallback(async () => {
    try {
      await signOut();
    } catch { /* the cookie expires on its own */ }
    setMe({ user: null });
    setView("auctions");
    disconnect();
  }, [disconnect]);

  const refresh = useCallback(async () => {
    try {
      const rows = await listAuctions();
      setAuctions(rows);
      setApiError(null);
      const pick = selected ?? rows[0]?.policyId ?? null;
      if (pick) {
        const d = await getAuction(pick);
        setDetail(d);
        // The bid has landed in the read model once the indexer has seen it.
        if (pending && d.events.some((e) => e.txHash === pending)) {
          setPending(null);
          void refreshBalance();
        }
      }
    } catch (e) {
      setApiError(e instanceof Error ? e.message : String(e));
    }
  }, [selected, pending, refreshBalance]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), pending ? POLL_MS_PENDING : POLL_MS);
    return () => clearInterval(id);
  }, [refresh, pending]);

  const current = useMemo(
    () => detail && (!selected || detail.policyId === selected) ? detail : null,
    [detail, selected],
  );

  return (
    <div className="wrap">
      <header>
        <h1>Cardano Auction</h1>
        {me.user && (
          <nav>
            <button
              className={`tab ${view === "auctions" ? "on" : ""}`}
              onClick={() => setView("auctions")}
            >
              Auctions
            </button>
            <button
              className={`tab ${view === "history" ? "on" : ""}`}
              onClick={() => setView("history")}
            >
              History
            </button>
            <button
              className={`tab ${view === "profile" ? "on" : ""}`}
              onClick={() => setView("profile")}
            >
              Profile
            </button>
          </nav>
        )}
        <span className="spacer" />
        {conn
          ? (
            <>
              <span className={me.user?.displayName ? "badge" : "badge mono"}>
                {signingIn
                  ? <><span className="spin" /> signing in…</>
                  : me.user?.displayName ?? short(conn.address, 12, 6)}
              </span>
              <button className="link" onClick={leave}>
                {me.user ? "sign out" : "disconnect"}
              </button>
            </>
          )
          : wallets.length === 0
          ? <span className="badge">no wallet detected</span>
          : (
            <span className="wallets">
              {wallets.map((w) => (
                <button key={w.key} disabled={busy} onClick={() => connectAndSignIn(w.key)}>
                  {w.icon && <img src={w.icon} alt="" />}
                  {busy ? "connecting…" : `Connect ${w.name}`}
                </button>
              ))}
            </span>
          )}
      </header>

      {walletError && <div className="notice err">{walletError}</div>}
      {signInError && <div className="notice err">{signInError}</div>}

      {conn && !me.user && !signingIn && !signInError && (
        <div className="notice info">
          Wallet connected — you can bid. To get a profile and bid history,{" "}
          <button className="inline" onClick={() => void signInAgain()}>sign in</button>{" "}
          by signing a message. It authorises no payment.
        </div>
      )}
      {apiError && (
        <div className="notice err">
          Could not reach the indexer: {apiError}
          {"\n"}Is it running?  cd off-chain && deno task serve --sync
        </div>
      )}

      {pending && (
        <div className="notice info">
          <span className="spin" /> Waiting for{" "}
          <a href={txUrl(pending)} target="_blank" rel="noreferrer">{short(pending, 14, 8)} ↗</a>
          {" "}to reach the chain. This updates on its own.
        </div>
      )}

      {welcome && (
        <div className="notice ok">
          Account created — your wallet signature was the only credential needed, so there is no
          password to remember or lose. Fill in whatever you want below; all of it is optional,
          and none of it goes on the chain.
        </div>
      )}

      {view === "profile" && me.user && <Profile me={me} onMe={setMe} />}
      {view === "history" && me.user && <History />}

      {view === "auctions" && auctions === null && <div className="empty">Loading…</div>}
      {view === "auctions" && auctions !== null && auctions.length === 0 && (
        <div className="empty">
          No auctions indexed yet.<br />
          <span className="sub">Open one with `deno task open-auction`, then `deno task sync`.</span>
        </div>
      )}

      {view === "auctions" && auctions !== null && auctions.length > 1 && (
        <div style={{ marginBottom: 18 }}>
          {auctions.map((a) => (
            <div
              key={a.policyId}
              className="card click"
              style={{
                padding: "12px 16px",
                marginBottom: 8,
                borderColor: a.policyId === current?.policyId ? "var(--accent-dim)" : undefined,
              }}
              onClick={() => setSelected(a.policyId)}
            >
              <div className="card-top" style={{ marginBottom: 0 }}>
                <span className="lot" style={{ fontSize: 15 }}>{a.tokenName}</span>
                <span className={`phase ${a.phase}`}>{a.phase}</span>
                <span style={{ flex: 1 }} />
                <span className="sub">
                  {a.leader
                    ? (
                      <>
                        {ada(a.leader.amountLovelace)} ₳
                        {a.leader.name && <span className="by"> by {a.leader.name}</span>}
                      </>
                    )
                    : `reserve ${ada(a.minBidLovelace)} ₳`}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {view === "auctions" && current && (
        <Detail
          auction={current}
          events={current.events}
          conn={conn}
          onBid={(h) => {
            setPending(h);
            setModal(h);
            void refreshBalance();
          }}
        />
      )}

      {modal && <SuccessModal txHash={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
