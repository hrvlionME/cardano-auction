/**
 * Creating an auction, entirely from the browser.
 *
 * **Two transactions, and they have to be two.** The auction validator is
 * parameterised by the lot's CurrencySymbol, and that symbol *is* the minting
 * policy's hash, which depends on the seed UTxO the mint consumes. So there is
 * no auction address to compute until the token exists. The wizard makes that
 * structural fact visible rather than hiding it behind one spinner:
 *
 *   1  mint    one-shot policy, parameterised by a UTxO from your wallet.
 *              Consuming it is the whole uniqueness argument: a UTxO can be
 *              spent once in the history of the chain, so the policy can
 *              succeed once.
 *   2  open    pay the token to the auction's script address with `Nothing`
 *              as the datum. No script runs here -- the ledger executes a
 *              validator when you *spend* from an address, never when you pay
 *              to one.
 *   3  list    tell this server the auction exists, so the indexer starts
 *              watching its address.
 *
 * **Both transactions are built by the command line's own code.** `mintLot()`
 * and `openAuction()` are imported unchanged from `off-chain/src/tx/`. The only
 * differences from `deno task mint-lot && deno task open-auction` are the
 * wallet (a CIP-30 extension rather than a seed phrase) and the provider (our
 * `/chain` proxy rather than Blockfrost directly).
 *
 * **Step 3 is the interesting one for the thesis.** Steps 1 and 2 are the
 * contract; nobody, this server included, can interfere with them. Step 3 is
 * pure discovery, and it exists only because compile-time parameters mean every
 * auction is a different script at a different address, with no contract to
 * watch. If it fails, the auction is still open and still correct on-chain --
 * it is merely invisible here, which is why the failure message says exactly
 * that instead of pretending the auction did not happen.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { fromText } from "@lucid-evolution/lucid";
import { mintLot } from "@core/tx/mint-lot.ts";
import { openAuction } from "@core/tx/open-auction.ts";
import { awaitUtxo, awaitWalletAsset } from "@core/lucid.ts";
import { serialiseParams } from "@core/state.ts";
import { network } from "@core/config.ts";
import { type Connected, useSession } from "../session.tsx";
import { registerListing, uploadImage } from "../lots.ts";
import { ada, label } from "../format.ts";
import { Notice, Spinner } from "../ui.tsx";
import { txUrl } from "../chain.ts";

/** Matches `MIN_BID_FLOOR` in the transaction builder, which explains why. */
const MIN_RESERVE_ADA = 2;

/** Enough for the fee plus the min-ADA two outputs will need, with margin. */
const MIN_BALANCE = 10_000_000n;

const DURATIONS = [
  { label: "20 minutes", minutes: 20 },
  { label: "1 hour", minutes: 60 },
  { label: "6 hours", minutes: 360 },
  { label: "24 hours", minutes: 1440 },
  { label: "3 days", minutes: 4320 },
  { label: "7 days", minutes: 10080 },
];

const CATEGORIES = [
  "electronics",
  "computers",
  "collectibles",
  "art",
  "jewellery",
  "vehicles",
  "furniture",
  "other",
];
const CONDITIONS = ["new", "like-new", "excellent", "good", "fair", "for-parts"];

/**
 * A token name from a title: upper case, ASCII, and short.
 *
 * An asset name is at most 32 bytes on-chain. It is also the one label every
 * lot has -- the fallback the interface shows when there is no description --
 * so it should be readable rather than a hash.
 */
function slugToken(title: string): string {
  return title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 32) || "LOT";
}

type Stage =
  | { at: "form" }
  | { at: "minting" }
  | { at: "mint-confirming"; txHash: string }
  | { at: "opening" }
  | { at: "open-confirming"; txHash: string }
  | { at: "registering" }
  | { at: "uploading" }
  | { at: "done"; policyId: string }
  | { at: "failed"; message: string; after: string; recoverable: string | null };

const STEPS = [
  { key: "mint", label: "Mint the lot" },
  { key: "open", label: "Open the auction" },
  { key: "list", label: "List it here" },
];

function stepIndex(s: Stage): number {
  switch (s.at) {
    case "minting":
    case "mint-confirming":
      return 0;
    case "opening":
    case "open-confirming":
      return 1;
    case "registering":
    case "uploading":
      return 2;
    case "done":
      return 3;
    default:
      return -1;
  }
}

export default function Sell() {
  const { conn, me, connectWallet, signIn, signingIn, wallets } = useSession();
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [tokenEdited, setTokenEdited] = useState(false);
  const [category, setCategory] = useState("");
  const [condition, setCondition] = useState("");
  const [description, setDescription] = useState("");
  const [reserve, setReserve] = useState("5");
  const [minutes, setMinutes] = useState(60);
  const [photo, setPhoto] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>({ at: "form" });

  const token = tokenEdited ? tokenName : slugToken(title);
  const reserveAda = Number(reserve);
  const reserveOk = Number.isFinite(reserveAda) && reserveAda >= MIN_RESERVE_ADA;
  const tokenOk = /^[A-Z0-9]{1,32}$/.test(token);
  const canSubmit = title.trim().length > 0 && tokenOk && reserveOk && conn !== null;

  async function run(c: Connected) {
    const meta = {
      title: title.trim(),
      description: description.trim(),
      category,
      condition,
    };

    // ------------------------------------------------------------ 1. mint
    let lot;
    try {
      setStage({ at: "minting" });
      lot = await mintLot(c.lucid, token);
      setStage({ at: "mint-confirming", txHash: lot.txHash });
      await c.lucid.awaitTx(lot.txHash);
      // Not enough on its own: the wallet's own view of its assets trails the
      // node. Wait until it agrees it holds the token, or `openAuction` will
      // refuse a lot that demonstrably exists.
      await awaitWalletAsset(c.lucid, lot.unit);
    } catch (e) {
      return setStage({
        at: "failed",
        after: "minting the lot",
        message: e instanceof Error ? e.message : String(e),
        recoverable: null,
      });
    }

    // ------------------------------------------------------------ 2. open
    let opened;
    try {
      setStage({ at: "opening" });
      opened = await openAuction(c.lucid, { ...lot, tokenName: token, network }, {
        minBid: BigInt(Math.round(reserveAda * 1_000_000)),
        endTime: BigInt(Date.now() + minutes * 60_000),
      });
      setStage({ at: "open-confirming", txHash: opened.txHash });
      await c.lucid.awaitTx(opened.txHash);
      // Poll rather than guess the output index: the address index lags the
      // transaction and would otherwise report the UTxO this one consumed.
      await awaitUtxo(c.lucid, opened.address, opened.txHash, { unit: opened.unit });
    } catch (e) {
      return setStage({
        at: "failed",
        after: "opening the auction",
        message: e instanceof Error ? e.message : String(e),
        recoverable:
          `The lot was minted (${lot.policyId}) and is in your wallet. Nothing is lost; ` +
          `you can open an auction for it from the command line with ` +
          `\`deno task open-auction\`.`,
      });
    }

    // ------------------------------------------------------------ 3. list
    try {
      setStage({ at: "registering" });
      await registerListing({
        params: serialiseParams(opened.params),
        lot: {
          seed: lot.seed,
          sellerPkh: lot.sellerPkh,
          tokenNameHex: fromText(token),
        },
        tokenName: token,
        openTxHash: opened.txHash,
        meta,
      });
    } catch (e) {
      return setStage({
        at: "failed",
        after: "listing the auction on this site",
        message: e instanceof Error ? e.message : String(e),
        recoverable:
          `The auction is open and correct on the chain — it is only missing from this ` +
          `site's index. Nobody's money is affected. Its policy id is ${lot.policyId}.`,
      });
    }

    // Optional, and deliberately last: a failed upload must not cost the
    // registration that already succeeded.
    if (photo) {
      try {
        setStage({ at: "uploading" });
        await uploadImage(lot.policyId, photo);
      } catch { /* the seller can add a photo from the auction page */ }
    }

    setStage({ at: "done", policyId: lot.policyId });
  }

  // ------------------------------------------------------------ rendering

  if (!me.user) {
    return (
      <div className="panel narrow">
        <h2>Sign in to sell</h2>
        <p className="prose">
          Selling needs an account, because the listing — the title, the photograph, the
          description — is ours to store and has to belong to somebody. Bidding does not: a bid is
          a transaction the chain validates, and this server is never consulted for one.
        </p>
        {conn
          ? (
            <div className="formfoot">
              <button className="btn primary" disabled={signingIn} onClick={() => void signIn()}>
                {signingIn ? <><Spinner /> waiting for your wallet…</> : "Sign in with this wallet"}
              </button>
              <span className="sub">One signature. It authorises no payment.</span>
            </div>
          )
          : wallets.length === 0
          ? <Notice kind="warn">No CIP-30 wallet detected in this browser.</Notice>
          : (
            <div className="walletlist">
              {wallets.map((w) => (
                <button key={w.key} className="btn primary" onClick={() => void connectWallet(w.key)}>
                  {w.icon && <img src={w.icon} alt="" />} Connect {w.name}
                </button>
              ))}
            </div>
          )}
      </div>
    );
  }

  if (stage.at === "done") {
    return (
      <div className="panel narrow center">
        <div className="tick">✓</div>
        <h2>Your auction is live</h2>
        <p className="prose">
          The lot is locked at its own script address. It can only move by a transaction the
          validator accepts — a bid before the deadline, or a payout after it. Not even you can
          take it back early, which is the property that makes the reserve meaningful.
        </p>
        <button className="btn primary" onClick={() => navigate(`/auction/${stage.policyId}`)}>
          View the auction
        </button>
      </div>
    );
  }

  if (stage.at === "failed") {
    return (
      <div className="panel narrow">
        <h2>Stopped while {stage.after}</h2>
        <Notice kind="err">{stage.message}</Notice>
        {stage.recoverable && <Notice kind="info">{stage.recoverable}</Notice>}
        <button className="btn" onClick={() => setStage({ at: "form" })}>Start again</button>
      </div>
    );
  }

  const running = stage.at !== "form";
  const step = stepIndex(stage);

  if (running) {
    const detail: Record<string, string> = {
      "minting": "Approve the mint in your wallet.",
      "mint-confirming": "Waiting for the mint to reach a block. A minute or two.",
      "opening": "Approve the second transaction: locking the lot at the auction's address.",
      "open-confirming": "Waiting for the auction to reach a block.",
      "registering": "Telling the indexer this auction exists.",
      "uploading": "Uploading your photograph.",
    };
    const txHash = "txHash" in stage ? stage.txHash : null;

    return (
      <div className="panel narrow">
        <h2>Creating your auction</h2>
        <ol className="wizard">
          {STEPS.map((s, i) => (
            <li key={s.key} className={i < step ? "done" : i === step ? "now" : ""}>
              <span className="dot">{i < step ? "✓" : i + 1}</span>
              <span>{s.label}</span>
            </li>
          ))}
        </ol>
        <p className="prose">
          <Spinner /> {detail[stage.at]}
        </p>
        {txHash && (
          <a className="txlink" href={txUrl(txHash)} target="_blank" rel="noreferrer">
            {txHash.slice(0, 16)}… ↗
          </a>
        )}
        <p className="fine">
          Two transactions are needed, and it could not be one: the auction's script is
          parameterised by the lot's policy id, which is itself a hash of the UTxO the mint
          consumes. There is no auction address to compute until the token exists. Leave this tab
          open.
        </p>
      </div>
    );
  }

  const lowBalance = conn !== null && conn.balance < MIN_BALANCE;

  return (
    <div className="panel narrow">
      <h2>Sell an item</h2>
      <p className="prose">
        This mints a one-of-a-kind token standing for your item, then locks it in an auction
        contract until the deadline. Both transactions are signed in your wallet; this site never
        holds the lot or the bids.
      </p>

      {!conn && <Notice kind="warn">Connect a wallet to continue.</Notice>}
      {lowBalance && (
        <Notice kind="warn">
          This wallet holds {ada(conn!.balance)} ₳. Two transactions plus the min-ADA their
          outputs need wants at least {ada(MIN_BALANCE)} ₳.
        </Notice>
      )}

      <label>
        <span>What are you selling?</span>
        <input
          value={title}
          maxLength={140}
          placeholder="MacBook Pro 14-inch, 2023"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label>
        <span>
          Token name <span className="sub">the on-chain name of the lot; capitals and digits, 32 max</span>
        </span>
        <input
          className="mono"
          value={token}
          onChange={(e) => {
            setTokenEdited(true);
            setTokenName(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32));
          }}
        />
        {!tokenOk && title && <span className="fielderr">Needs at least one letter or digit.</span>}
      </label>

      <div className="row2">
        <label>
          <span>Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">—</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </select>
        </label>
        <label>
          <span>Condition</span>
          <select value={condition} onChange={(e) => setCondition(e.target.value)}>
            <option value="">—</option>
            {CONDITIONS.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </select>
        </label>
      </div>

      <label>
        <span>Description</span>
        <textarea
          rows={4}
          value={description}
          placeholder="What it is, what condition it is in, what is included."
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <label>
        <span>Photograph <span className="sub">optional; you can add one later</span></span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        />
      </label>

      <div className="row2">
        <label>
          <span>Reserve price</span>
          <div className="amountfield">
            <input
              type="number"
              min={MIN_RESERVE_ADA}
              step={1}
              value={reserve}
              onChange={(e) => setReserve(e.target.value)}
            />
            <span className="unit">₳</span>
          </div>
          {!reserveOk && (
            <span className="fielderr">
              At least {MIN_RESERVE_ADA} ₳: after the first bid the auction UTxO holds exactly the
              bid, and an output below min-ADA is rejected by the ledger itself.
            </span>
          )}
        </label>
        <label>
          <span>Bidding closes in</span>
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {DURATIONS.map((d) => <option key={d.minutes} value={d.minutes}>{d.label}</option>)}
          </select>
        </label>
      </div>

      <p className="fine">
        The deadline is enforced by the validator through the transaction's validity interval, not
        by a timer on this server. After it passes, anyone may submit the settlement — a
        blockchain has no scheduler, so the contract guarantees that settling is <em>correct</em>,
        never that somebody gets round to it.
      </p>

      <div className="formfoot">
        <button className="btn primary" disabled={!canSubmit} onClick={() => conn && run(conn)}>
          Mint and open the auction
        </button>
        <span className="sub">Two wallet signatures, a minute or two apart.</span>
      </div>
    </div>
  );
}
