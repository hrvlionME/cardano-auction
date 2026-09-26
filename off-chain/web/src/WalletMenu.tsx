/**
 * Wallet connection and account access. Explicit connection signs in as part
 * of the same action, reusing a valid server session before requesting a
 * signature. Background reconnection never requests a login signature.
 * Transaction approvals remain separate and are always handled by the wallet.
 */
import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useSession } from "./session.tsx";
import { short } from "./format.ts";
import { Spinner } from "./ui.tsx";

export default function WalletMenu() {
  const {
    wallets,
    conn,
    me,
    connecting,
    signingIn,
    connectWallet,
    signIn,
    disconnect,
    signOut,
  } = useSession();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Close on a click elsewhere or on Escape, which is what anyone tries.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  async function pick(key: string) {
    setOpen(false);
    await connectWallet(key);
  }

  // ------------------------------------------------- signed in: name and menu
  if (me.user) {
    return (
      <div className="who" ref={box}>
        <NavLink className="badge" to="/account">
          {me.user.displayName ?? short(me.address ?? "", 10, 5)}
        </NavLink>
        <button className="link" onClick={() => void signOut()}>sign out</button>
      </div>
    );
  }

  // ------------------------------- connected, no account: bidding already works
  if (conn) {
    return (
      <div className="who" ref={box}>
        <span className="badge mono" title={conn.address}>{short(conn.address, 10, 5)}</span>
        <button className="btn small" disabled={signingIn} onClick={() => void signIn()}>
          {signingIn ? <><Spinner /> signing…</> : "Sign in"}
        </button>
        <button className="link" onClick={disconnect}>disconnect</button>
      </div>
    );
  }

  // --------------------------------------------------------- not connected yet
  return (
    <div className="walletmenu" ref={box}>
      <button
        className="btn small primary"
        aria-expanded={open}
        aria-controls="wallet-options"
        disabled={connecting || signingIn}
        onClick={() => setOpen((o) => !o)}
      >
        {connecting ? <><Spinner /> connecting…</> : "Connect & sign in"}
      </button>

      {open && (
        <div className="dropdown" id="wallet-options">
          {wallets.length === 0
            ? (
              <div className="dropnote">
                <strong>No wallet detected.</strong>
                Eternl, Lace, Nami, Flint, Typhon and Vespr all satisfy CIP-30 — nothing here is
                specific to one. Extensions inject themselves as the page loads, so reload if you
                have just installed one.
              </div>
            )
            : (
              <>
                {wallets.map((w) => (
                  <button key={w.key} className="dropitem" onClick={() => void pick(w.key)}>
                    {w.icon ? <img src={w.icon} alt="" /> : <span className="noicon" />}
                    <span>{w.name}</span>
                  </button>
                ))}
                <div className="dropnote">
                  Choose a wallet to connect and sign in. First-time login asks you to sign a
                  message, not a payment. Returning visits use your saved session.
                </div>
              </>
            )}
        </div>
      )}
    </div>
  );
}
