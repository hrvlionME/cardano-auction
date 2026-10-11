/**
 * The account pages: profile and history, behind one tab strip.
 *
 * History is worth a note. It is a *join*, not a table — `events`, which the
 * indexer derived from the chain, against the addresses this account has proved
 * by signature. Nothing about anyone's bids is stored twice. The consequence
 * worth stating: a user's history here is verifiable against a public explorer,
 * where on a conventional site it is whatever the operator's database says.
 */
import { NavLink, Route, Routes } from "react-router-dom";
import { useSession } from "../session.tsx";
import Profile from "../Profile.tsx";
import Assets from "../Assets.tsx";
import History from "../History.tsx";
import { Notice } from "../ui.tsx";

export default function Account() {
  const { me, setMe } = useSession();

  if (!me.user) {
    return (
      <div className="panel narrow">
        <Notice kind="info">Sign in to see your account.</Notice>
      </div>
    );
  }

  return (
    <>
      <div className="page-heading"><span className="eyebrow">Your space</span><h1 className="page-title">{me.user.displayName ? `${me.user.displayName}’s account` : "My account"}</h1><p className="prose">Your collection, bids, and profile in one place.</p></div>
      <nav className="subnav" aria-label="Account navigation">
        <NavLink end to="/account">My assets</NavLink>
        <NavLink to="/account/profile">Profile</NavLink>
        <NavLink to="/account/history">Bidding history</NavLink>
      </nav>
      <Routes>
        <Route index element={<Assets />} />
        <Route path="profile" element={<Profile me={me} onMe={setMe} />} />
        <Route path="history" element={<History />} />
      </Routes>
    </>
  );
}
