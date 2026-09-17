/**
 * The seller's description of their own item.
 *
 * **Everything on this form is operator-held and operator-editable, and the
 * interface says so.** That is not an apology for a shortcut; it is where the
 * boundary honestly falls. The rule that put it here: *if this row were
 * deleted, forged, or edited by the operator, could anyone lose money?* Editing
 * a photograph is a lie the seller's reputation pays for. Editing a bid is
 * theft. Only the second needs a ledger.
 *
 * The alternative exists and was considered: CIP-25 and CIP-68 write NFT
 * metadata into the minting transaction, which would make the description as
 * tamper-evident as the ownership. It costs fees per byte, cannot be corrected
 * after minting, and is unusable for images — which is why production
 * marketplaces do exactly what this does and pin images elsewhere, keeping at
 * most a hash on-chain.
 *
 * Who may edit is *not* an operator decision either. There is no seller role
 * and no owner column: the server checks that the account has proved control of
 * the address the compiled script will pay. The right to describe the goods
 * follows from a fact on the chain.
 */
import { useRef, useState } from "react";
import { type Lot, type LotPatch, saveLot, uploadImage } from "./lots.ts";
import { label } from "./format.ts";
import { LotImage, Notice, Spinner } from "./ui.tsx";

interface Props {
  policyId: string;
  tokenName: string;
  item: Lot | null;
  vocabulary: { categories: string[]; conditions: string[] };
  onSaved: () => void;
}

export default function EditListing({ policyId, tokenName, item, vocabulary, onSaved }: Props) {
  const [open, setOpen] = useState(item === null || item.title === null);
  const [draft, setDraft] = useState<LotPatch>({});
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const value = <K extends keyof LotPatch>(k: K): string => draft[k] ?? item?.[k] ?? "";
  const set = (k: keyof LotPatch, v: string) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setSaved(false);
  };

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await saveLot(policyId, {
        title: value("title"),
        description: value("description"),
        category: value("category"),
        condition: value("condition"),
      });
      setDraft({});
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickImage(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await uploadImage(policyId, file);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  if (!open) {
    return (
      <div className="selleredit closed">
        <span className="sub">You are the seller of this lot.</span>
        <button className="btn" onClick={() => setOpen(true)}>Edit listing</button>
      </div>
    );
  }

  return (
    <section className="panel selleredit">
      <h3>
        Edit listing <span className="sub">only you can — the script pays your address</span>
      </h3>

      <div className="editgrid">
        <div className="imagecol">
          <LotImage item={item} tokenName={tokenName} className="big" />
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => void pickImage(e.target.files?.[0])}
          />
          <button
            className="btn"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? <><Spinner /> uploading…</> : item?.imageUrl ? "Replace photo" : "Add a photo"}
          </button>
          <p className="fine">
            PNG, JPEG, GIF or WebP, up to 5 MB. Stored under the hash of its own bytes, so the
            same photograph uploaded twice costs one file and no uploader chooses a filename.
          </p>
        </div>

        <div className="fieldcol">
          <label>
            <span>Title</span>
            <input
              value={value("title")}
              maxLength={140}
              placeholder="MacBook Pro 14-inch, 2023"
              onChange={(e) => set("title", e.target.value)}
            />
          </label>

          <div className="row2">
            <label>
              <span>Category</span>
              <select value={value("category")} onChange={(e) => set("category", e.target.value)}>
                <option value="">—</option>
                {vocabulary.categories.map((c) => <option key={c} value={c}>{label(c)}</option>)}
              </select>
            </label>
            <label>
              <span>Condition</span>
              <select value={value("condition")} onChange={(e) => set("condition", e.target.value)}>
                <option value="">—</option>
                {vocabulary.conditions.map((c) => <option key={c} value={c}>{label(c)}</option>)}
              </select>
            </label>
          </div>

          <label>
            <span>Description</span>
            <textarea
              rows={5}
              value={value("description")}
              placeholder="What it is, what condition it is in, what is included."
              onChange={(e) => set("description", e.target.value)}
            />
          </label>

          <div className="formfoot">
            <button className="btn primary" onClick={submit} disabled={busy}>
              {busy ? <><Spinner /> saving…</> : "Save listing"}
            </button>
            <button className="btn ghost" onClick={() => setOpen(false)}>Close</button>
            {saved && <span className="ok-inline">Saved</span>}
          </div>
        </div>
      </div>

      <p className="fine">
        None of this goes on the chain. The contract guarantees the money; the seller describes
        the goods — exactly as with any physical delivery.
      </p>

      {error && <Notice kind="err">{error}</Notice>}
    </section>
  );
}
