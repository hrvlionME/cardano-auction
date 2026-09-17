/**
 * The shell: header, routes, footer.
 *
 * The footer is not decoration. The thesis title says "decentralized", and this
 * system is decentralized in the parts that matter most and centralized in
 * several that also matter — custody and settlement are enforced by a validator
 * nobody can override, while discovery, identity, the description of the goods
 * and physical delivery are all the operator's. Stating that where a user can
 * read it costs nothing and is more honest than a footer that says "powered by
 * blockchain".
 */
import { useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { useSession } from "./session.tsx";
import { Notice } from "./ui.tsx";
import { network } from "./chain.ts";
import WalletMenu from "./WalletMenu.tsx";
import Browse from "./pages/Browse.tsx";
import AuctionPage from "./pages/AuctionPage.tsx";
import Sell from "./pages/Sell.tsx";
import Account from "./pages/Account.tsx";

function Header() {
  const { me } = useSession();

  return (
    <header>
      {/*
        The mark alone, with no wordmark beside it. It is still a link home, so
        it still needs an accessible name -- a screen reader announcing "link, ₳"
        is not one, which is why the label is on the link rather than left to
        the glyph.
      */}
      <NavLink className="brand" to="/" aria-label="Home">
        <span className="mark" aria-hidden="true">₳</span>
      </NavLink>

      <nav>
        <NavLink end to="/">Browse</NavLink>
        <NavLink to="/sell">Sell</NavLink>
        {me.user && <NavLink to="/account">Account</NavLink>}
      </nav>

      <span className="spacer" />
      <span className="net" title="The network this build is configured for">{network}</span>
      <WalletMenu />
    </header>
  );
}

export default function App() {
  const { conn, me, signingIn, error, isNew, clearIsNew, signIn } = useSession();
  const [hideHint, setHideHint] = useState(false);

  return (
    <>
      <Header />
      <main className="wrap">
        {error && <Notice kind="err">{error}</Notice>}

        {conn && !me.user && !signingIn && !hideHint && (
          <Notice kind="info">
            Wallet connected — <strong>you can bid right now</strong>. An account is optional and
            adds only what the chain does not know: a name, a delivery address, your history in
            one place.{" "}
            <button className="inline" onClick={() => void signIn()}>Sign in</button> by signing a
            message once; it authorises no payment.{" "}
            <button className="inline" onClick={() => setHideHint(true)}>Dismiss</button>
          </Notice>
        )}

        {isNew && (
          <Notice kind="ok">
            Account created — your wallet signature was the only credential needed, so there is no
            password to remember or lose.{" "}
            <NavLink to="/account" onClick={clearIsNew}>Add a name and delivery details</NavLink>,
            or <button className="inline" onClick={clearIsNew}>skip it</button>. All of it is
            optional, and none of it goes on the chain.
          </Notice>
        )}

        <Routes>
          <Route path="/" element={<Browse />} />
          <Route path="/auction/:policyId" element={<AuctionPage />} />
          <Route path="/sell" element={<Sell />} />
          <Route path="/account/*" element={<Account />} />
          <Route
            path="*"
            element={
              <div className="empty">
                <strong>No such page.</strong>
                <p className="sub"><NavLink to="/">Back to the auctions</NavLink></p>
              </div>
            }
          />
        </Routes>
      </main>

      <footer>
        <div className="wrap footgrid">
          <div>
            <strong>Decentralized where it counts</strong>
            <p>
              Custody, settlement and the auction rules are enforced by a Plutus validator: no
              participant, this site's operator included, can seize a bid or alter a result.
            </p>
          </div>
          <div>
            <strong>Centralized where it must be</strong>
            <p>
              Discovery, identity, the description of the goods and physical delivery are ours.
              Personal data is kept off the chain precisely so it can be corrected and erased.
            </p>
          </div>
          <div>
            <strong>Check us</strong>
            <p>
              Every figure on this site links to a public explorer. The database is a cache that
              can be thrown away and rebuilt from the ledger.
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
