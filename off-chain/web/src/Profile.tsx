import { useState } from "react";
import { saveProfile } from "./auth.ts";
import type { Me, ProfilePatch, User } from "./types.ts";

const FIELDS: { key: keyof ProfilePatch; label: string; placeholder?: string; width?: string }[] = [
  { key: "displayName", label: "Display name", placeholder: "How you appear on the site" },
  { key: "email", label: "Email", placeholder: "you@example.com" },
  { key: "fullName", label: "Full name", placeholder: "For delivery and identity checks" },
  { key: "addressLine", label: "Street address" },
  { key: "city", label: "City", width: "1 / 2" },
  { key: "postcode", label: "Postcode", width: "1 / 2" },
  { key: "country", label: "Country (2 letters)", placeholder: "HR", width: "1 / 2" },
];

function ProfileForm({ user, onSaved }: { user: User; onSaved: (m: Me) => void }) {
  const [draft, setDraft] = useState<ProfilePatch>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const value = (k: keyof ProfilePatch) => draft[k] ?? user[k] ?? "";
  const dirty = Object.keys(draft).length > 0;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await saveProfile(draft));
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-top">
        <span className="lot">Your details</span>
        <span className={`phase ${user.kycStatus === "verified" ? "bidding" : "closed"}`}>
          KYC {user.kycStatus}
        </span>
      </div>
      <p className="sub" style={{ marginTop: 4 }}>
        None of this is on the chain, and none of it can be. A ledger is permanent and public;
        this is stored where it can be corrected and deleted.
      </p>

      <div className="form">
        {FIELDS.map((f) => (
          <label key={f.key} style={{ gridColumn: f.width ? `span 1` : "1 / -1" }}>
            <span>{f.label}</span>
            <input
              type={f.key === "email" ? "email" : "text"}
              value={String(value(f.key))}
              placeholder={f.placeholder}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>

      {error && <div className="notice err">{error}</div>}

      <div className="bidrow" style={{ marginTop: 14 }}>
        <button className="primary" onClick={submit} disabled={busy || !dirty}>
          {busy ? <><span className="spin" /> saving…</> : "Save"}
        </button>
        {saved && <span className="sub" style={{ color: "var(--live)" }}>Saved.</span>}
      </div>
    </div>
  );
}

function Addresses({ addresses, current }: { addresses: string[]; current?: string }) {
  return (
    <div className="card">
      <div className="card-top"><span className="lot">Wallet addresses</span></div>
      <p className="sub" style={{ marginTop: 4 }}>
        Each was proved by its own signature. A wallet holds more than one address, so bidding
        from another and signing in there adds it to this account.
      </p>
      {addresses.map((a) => (
        <div key={a} className="addrrow">
          <span className="addr">{a}</span>
          {a === current && <span className="phase bidding">this session</span>}
        </div>
      ))}
    </div>
  );
}

export default function Profile({ me, onMe }: { me: Me; onMe: (m: Me) => void }) {
  if (!me.user) return null;
  return (
    <>
      <ProfileForm user={me.user} onSaved={onMe} />
      <Addresses addresses={me.addresses ?? []} current={me.address} />
    </>
  );
}
