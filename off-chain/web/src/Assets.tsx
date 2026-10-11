import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "./session.tsx";
import { useListings } from "./data.ts";
import type { Listing } from "./lots.ts";
import { ada, short } from "./format.ts";
import { LotImage, Notice, Tags } from "./ui.tsx";

function AssetCard({ listing: l, pending = false }: { listing: Listing; pending?: boolean }) {
  return (
    <Link className="lotcard" to={`/auction/${l.policyId}`}>
      <div className="lotcard-img">
        <LotImage item={l.item} tokenName={l.tokenName} />
        <span className={`phase ${pending ? "closed" : "settled"}`}>
          {pending ? "Awaiting settlement" : "In your wallet"}
        </span>
      </div>
      <div className="lotcard-body">
        <h3>{l.item?.title ?? l.tokenName}</h3>
        <Tags item={l.item} />
        <span className="sub mono" title={l.policyId}>Policy {short(l.policyId, 12, 8)}</span>
        <div className="lotcard-foot">
          <div><div className="label">Final bid</div><div className="price">{ada(l.leader?.amountLovelace ?? 0)}<small>₳</small></div></div>
          <div className="right"><div className="label">Auction ended</div><span className="sub">{new Date(l.endTime).toLocaleDateString()}</span></div>
        </div>
        <div className="card-action">{pending ? "Settle auction" : "View item & claim"}<span aria-hidden="true">→</span></div>
      </div>
    </Link>
  );
}

export default function Assets() {
  const { conn, me } = useSession();
  const { data, error } = useListings();
  const lucid = conn?.lucid;
  const [wallet, setWallet] = useState<{ lucid: typeof lucid; units: Set<string> } | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  useEffect(() => {
    setWallet(null);
    setWalletError(null);
    if (!lucid) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const utxos = await lucid!.wallet().getUtxos();
        const units = new Set(utxos.flatMap((u) =>
          Object.entries(u.assets).filter(([unit, quantity]) => unit !== "lovelace" && quantity > 0n).map(([unit]) => unit)
        ));
        if (live) { setWallet({ lucid, units }); setWalletError(null); }
      } catch (e) {
        if (live) { setWallet(null); setWalletError(e instanceof Error ? e.message : String(e)); }
      } finally {
        if (live) timer = setTimeout(() => void refresh(), 8000);
      }
    }
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [lucid]);

  const held = wallet?.lucid === lucid ? wallet?.units : undefined;
  const owned = data?.filter((l) => held?.has(l.unit)) ?? [];
  const addresses = new Set([...(me.addresses ?? []), me.address, conn?.address]);
  const pending = data?.filter((l) => l.phase === "closed" && l.leader?.address && addresses.has(l.leader.address)) ?? [];

  return (
    <>
      <div className="section-heading"><h2>My assets</h2>{held && data && <span className="sub">{owned.length} auction NFTs</span>}</div>
      <p className="prose">Your auction NFTs in the connected wallet. Open an item to see its auction and confirm receipt when it arrives.</p>
      {error && <Notice kind="err">Could not load your auction items: {error}</Notice>}
      {!conn && <Notice>Connect your wallet to see the auction NFTs you currently hold.</Notice>}
      {walletError && <Notice kind="err">Could not read your wallet: {walletError}. Retrying automatically.</Notice>}
      {conn && !walletError && (!held || !data) && !error && <div className="empty" role="status">Loading your assets…</div>}
      {conn && held && data && owned.length === 0 && <div className="empty"><strong>No auction NFTs in this wallet yet.</strong><p className="sub">Won items appear after settlement confirms. Transferred or redeemed tokens are no longer shown here.</p><Link className="btn" to="/">Browse auctions</Link></div>}
      {owned.length > 0 && <div className="grid">{owned.map((l) => <AssetCard key={l.policyId} listing={l} />)}</div>}
      {pending.length > 0 && <section style={{ marginTop: 32 }}>
        <div className="section-heading"><h2>Won · awaiting settlement</h2><span className="sub">{pending.length} items</span></div>
        <p className="prose">You won these auctions. Settle each auction to deliver its NFT to the winning wallet.</p>
        <div className="grid">{pending.map((l) => <AssetCard key={l.policyId} listing={l} pending />)}</div>
      </section>}
    </>
  );
}
