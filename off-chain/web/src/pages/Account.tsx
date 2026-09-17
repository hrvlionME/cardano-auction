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
      <div className="subnav">
        <NavLink end to="/account">Profile</NavLink>
        <NavLink to="/account/history">Bidding history</NavLink>
      </div>
      <Routes>
        <Route index element={<Profile me={me} onMe={setMe} />} />
        <Route path="history" element={<History />} />
      </Routes>
    </>
  );
}
