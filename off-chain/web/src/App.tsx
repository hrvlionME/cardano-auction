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
      <NavLink className="brand" to="/" aria-label="Auction house home">
        <span className="mark" aria-hidden="true">₳</span>
        <span className="wordmark">Auction<span>house</span></span>
      </NavLink>

      <nav aria-label="Main navigation">
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
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Header />
      <main className="wrap" id="main-content" tabIndex={-1}>
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
            <strong>Your bids, protected</strong>
            <p>
              Bids and payouts follow rules enforced on Cardano. This site cannot take your bid
              or change the auction result.
            </p>
          </div>
          <div>
            <strong>Your details, private</strong>
            <p>
              Listings and delivery are managed off-chain. Your personal details stay off the
              public blockchain, where they can be updated or deleted.
            </p>
          </div>
          <div>
            <strong>Independently verifiable</strong>
            <p>
              Follow the explorer links on each auction to verify its transactions.
              Auction activity is recorded on the public blockchain.
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
