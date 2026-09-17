/**
 * Listings: the description of the goods, and the registry of auctions the
 * indexer has been told about.
 *
 * Two things live here and they are different in kind, so the rule that decides
 * where anything in this project goes is worth restating: *if this row were
 * deleted, forged, or edited by the operator, could anyone lose money?* Editing
 * a product photo is a lie the operator's reputation pays for; editing a bid is
 * theft. Only the second needs a ledger.
 *
 * So:
 *
 *   the `lots` table   title, description, condition, a photo. Operator-held,
 *                      operator-editable, and honestly so. The chain guarantees
 *                      the money; the operator describes the goods, exactly as
 *                      with any physical delivery.
 *
 *   registration       the list of auction addresses the indexer watches.
 *                      Authoritative in the narrow sense that it cannot be
 *                      recomputed -- see below -- but *verified*, not trusted.
 *
 * **Why a registry has to exist at all.** `AuctionParams` are compile-time
 * parameters, so every auction compiles to a different script with a different
 * hash and therefore a different address. There is no "the auction contract" to
 * watch. The indexer holds a list of addresses and can only ever learn about
 * auctions somebody told it about. For CLI-opened auctions that list comes from
 * `state/auction-*.json`; for browser-opened ones it comes from here.
 *
 * **But nothing submitted here is believed.** `registerListing` recomputes the
 * minting policy from its parameters and checks the policy id matches;
 * recomputes the auction's script address from its parameters and checks it
 * matches; and then asks the chain whether the opening transaction really did
 * put that token at that address. A client that lies fails all three. The
 * registry is therefore a *discovery* mechanism, not a source of truth -- which
 * is the honest shape of this whole boundary, and the reason "discovery is
 * centralized" is a row in the thesis's table rather than a hole in the design.
 */
import { mintingPolicyToId } from "@lucid-evolution/lucid";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { type AuctionRow, type Db, upsertAuction } from "../indexer/db.ts";
import { auctionAddress, lotPolicyScript } from "../blueprint.ts";
import { type AuctionState, deserialiseParams } from "../state.ts";
import { fromPlutusAddress } from "../types.ts";
import { blockfrostProjectId, blockfrostUrl, network } from "../config.ts";

/**
 * Operator-supplied description of an item.
 *
 * Note there is no price, no bid and no winner here. Those are on the chain,
 * and projecting them into this table would create two sources for one fact --
 * the failure the whole design exists to avoid.
 */
export interface Lot {
  policyId: string;
  title: string | null;
  description: string | null;
  category: string | null;
  condition: string | null;
  /** A path under /uploads, or null. See `saveImage`. */
  imageUrl: string | null;
  createdBy: number | null;
  updatedAt: string;
}

/**
 * Deliberately *not* added to the indexer's `TABLES`.
 *
 * `deno task db:reset` drops everything in that list and rebuilds it from the
 * chain. A title and a photograph cannot be rebuilt from a ledger, so if this
 * table were in that list the reset would silently destroy every description on
 * the site. There is also no foreign key to `auctions` for the same reason: the
 * reset drops that table, and ON DELETE CASCADE would take these rows with it.
 * The cost is that a row here can outlive its auction, which is harmless.
 */
export const LOT_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS lots (
     policy_id   VARCHAR(56)  NOT NULL,
     title       VARCHAR(140) NULL,
     description TEXT         NULL,
     category    VARCHAR(40)  NULL,
     condition_  VARCHAR(40)  NULL,
     image_url   VARCHAR(255) NULL,
     created_by  BIGINT       NULL,
     -- The submission that registered this auction, verbatim.
     --
     -- This is the one genuinely authoritative thing in the project: an
     -- auction's compile-time parameters cannot be recovered from the chain,
     -- because the chain stores the *hash* of the applied script and not the
     -- parameters that produced it. Without them there is no address to watch
     -- and no way to rebuild the minting policy for a burn. db:reset drops
     -- the indexer's tables and rebuilds them from the ledger; this column is
     -- what lets a browser-created auction survive that, exactly as a CLI one
     -- survives it by having a file in state/.
     registration TEXT        NULL,
     updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (policy_id),
     KEY lots_by_user (created_by)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/** Fields a seller may write about their own item. */
export interface LotPatch {
  title?: string;
  description?: string;
  category?: string;
  condition?: string;
}

/** What the sell flow submits once its two transactions have confirmed. */
export interface ListingSubmission {
  /** The auction's compile-time parameters, exactly as `AuctionState` stores them. */
  params: AuctionState["params"];
  /** The minting policy's parameters, so the burn can be rebuilt later. */
  lot: {
    seed: { txHash: string; outputIndex: number };
    sellerPkh: string;
    tokenNameHex: string;
  };
  /** Human-readable token name, for display beside the hex. */
  tokenName: string;
  /** The transaction that locked the lot at the auction address. */
  openTxHash: string;
  meta?: LotPatch;
}

const CATEGORIES = [
  "electronics",
  "computers",
  "collectibles",
  "art",
  "jewellery",
  "vehicles",
  "furniture",
  "other",
] as const;

const CONDITIONS = ["new", "like-new", "excellent", "good", "fair", "for-parts"] as const;

export const LOT_CATEGORIES: readonly string[] = CATEGORIES;
export const LOT_CONDITIONS: readonly string[] = CONDITIONS;

/** Raised when a submission does not survive verification. The message is shown. */
export class RegistrationError extends Error {}

interface TxUtxos {
  outputs: {
    address: string;
    amount: { unit: string; quantity: string }[];
  }[];
}

/**
 * Ask the chain whether a transaction really produced this output.
 *
 * Deliberately a question about a *transaction*, not about an address. A
 * per-address index trails confirmation by a few seconds, so an address query
 * made straight after `awaitTx` can answer from a view that has not caught up
 * and report an auction that plainly exists as missing. Asking about a named
 * transaction does not have that failure mode.
 */
async function txPaidTo(txHash: string, address: string, unit: string): Promise<boolean> {
  const res = await fetch(`${blockfrostUrl()}/txs/${txHash}/utxos`, {
    headers: { project_id: blockfrostProjectId() },
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new RegistrationError(
      `Could not check transaction ${txHash} against the chain ` +
        `(Blockfrost returned ${res.status}). Nothing was recorded; try again.`,
    );
  }
  const io = await res.json() as TxUtxos;
  return io.outputs.some(
    (o) => o.address === address && o.amount.some((a) => a.unit === unit && a.quantity === "1"),
  );
}

/**
 * Recompute an auction row from a submission, trusting none of it.
 *
 * Both the policy id and the script address are hashes of applied scripts, so
 * both are recomputable from the parameters alone. If a client invented either,
 * the recomputation disagrees and this throws. That is the same check every
 * transaction builder in the project makes before spending: never trust a
 * stored address, derive it.
 *
 * Shared by first-time registration and by the replay after `db:reset`, so a
 * replay also catches the case where the Haskell has moved since: the
 * parameters now compile to a different script, the addresses disagree, and the
 * auction is skipped loudly rather than indexed at an address nobody watches.
 */
async function deriveRow(sub: ListingSubmission): Promise<{ row: AuctionRow; sellerAddress: string }> {
  if (!sub?.params || !sub.lot?.seed?.txHash || !sub.openTxHash) {
    throw new RegistrationError("Incomplete submission: params, lot and openTxHash are required.");
  }

  // 1. The policy id is the minting policy's hash, so it is recomputable from
  //    the policy's own parameters. If the client invented either, these
  //    disagree.
  let policyId: string;
  try {
    const policy = await lotPolicyScript({
      lpSeedRef: {
        txOutRefId: sub.lot.seed.txHash,
        txOutRefIdx: BigInt(sub.lot.seed.outputIndex),
      },
      lpTokenName: sub.lot.tokenNameHex,
      lpSeller: sub.lot.sellerPkh,
    });
    policyId = mintingPolicyToId(policy);
  } catch (e) {
    throw new RegistrationError(
      `Could not rebuild the minting policy from those parameters: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (policyId !== sub.params.apCurrencySymbol) {
    throw new RegistrationError(
      `The lot parameters do not produce the currency symbol this auction was ` +
        `parameterised with (${policyId} vs ${sub.params.apCurrencySymbol}).`,
    );
  }

  // 2. The auction's address is likewise a hash of the applied script, so it is
  //    recomputable from the auction's parameters. This is the same check every
  //    transaction builder in this project makes before spending: never trust a
  //    stored address, derive it.
  let params, address: string;
  try {
    params = deserialiseParams(sub.params);
    address = await auctionAddress(params);
  } catch (e) {
    throw new RegistrationError(
      `Those auction parameters do not compile to a script: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const sellerAddress = fromPlutusAddress(params.apSeller);
  return {
    sellerAddress,
    row: {
      policyId,
      tokenName: sub.tokenName,
      unit: policyId + sub.params.apTokenName,
      address,
      sellerAddress,
      minBid: Number(params.apMinBid),
      endTime: Number(params.apEndTime),
      status: "open",
      network,
      seedTxHash: sub.lot.seed.txHash,
      seedOutputIndex: sub.lot.seed.outputIndex,
      sellerPkh: sub.lot.sellerPkh,
    },
  };
}

/**
 * Verify a submission and, if it holds up, record the auction and its listing.
 *
 * Three checks, in increasing cost: the parameters must be self-consistent
 * (`deriveRow`), the caller must have proved control of the address the script
 * will pay, and the chain must agree the auction actually exists.
 */
export async function registerListing(
  db: Db,
  sub: ListingSubmission,
  userId: number,
  ownsAddress: (address: string) => Promise<boolean>,
): Promise<AuctionRow> {
  const { row, sellerAddress } = await deriveRow(sub);

  // Only the seller may list. "Seller" is not taken from the request and is not
  // a role this server assigns -- it is read out of the parameters the script
  // was compiled with, and the caller must have proved control of that address
  // by signature.
  if (!await ownsAddress(sellerAddress)) {
    throw new RegistrationError(
      `This account has not proved control of the seller address for that auction.\n` +
        `Sign in with the wallet that opened it.`,
    );
  }

  // Everything above proves the parameters are self-consistent; only this
  // proves the auction exists.
  if (!await txPaidTo(sub.openTxHash, row.address, row.unit)) {
    throw new RegistrationError(
      `Transaction ${sub.openTxHash} does not put that lot at ${row.address}.\n` +
        `If it was submitted moments ago, wait for it to confirm and try again.`,
    );
  }

  await upsertAuction(db, row);
  await upsertLot(db, row.policyId, sub.meta ?? {}, userId);
  // Kept verbatim so `db:reset` can replay it. See the column's comment.
  await db.query(`UPDATE lots SET registration = ? WHERE policy_id = ?`, [
    JSON.stringify({
      params: sub.params,
      lot: sub.lot,
      tokenName: sub.tokenName,
      openTxHash: sub.openTxHash,
    }),
    row.policyId,
  ]);
  return row;
}

/**
 * Put every auction registered through the API back into the indexer's tables.
 *
 * The counterpart of `registerKnownAuctions`, which does the same for auctions
 * the CLI opened and recorded in `state/`. Both exist for one reason: because
 * `AuctionParams` are compile-time parameters, every auction is a different
 * script at a different address, so there is no contract to watch and the
 * indexer can only ever know about auctions it has been told about.
 *
 * Idempotent, and cheap enough to run on every sync: the work is hashing a few
 * applied scripts, with no network calls.
 */
export async function registerStoredListings(db: Db): Promise<AuctionRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT policy_id AS policyId, registration FROM lots WHERE registration IS NOT NULL`,
  );

  const out: AuctionRow[] = [];
  for (const r of rows) {
    let sub: ListingSubmission;
    try {
      sub = JSON.parse(r.registration as string) as ListingSubmission;
    } catch {
      console.log(`  skip  ${r.policyId}: its stored registration is not readable`);
      continue;
    }
    try {
      const { row } = await deriveRow(sub);
      await upsertAuction(db, row);
      out.push(row);
    } catch (e) {
      // Almost always means the Haskell moved and these parameters now compile
      // to a different script. History, not an error -- exactly as the CLI's
      // registration treats an auction recorded under an older datum format.
      console.log(
        `  skip  ${r.policyId}: ${e instanceof Error ? e.message.split("\n")[0] : e}`,
      );
    }
  }
  return out;
}

// ------------------------------------------------------------------- lots

const LOT_COLUMNS = `policy_id AS policyId, title, description, category,
                     condition_ AS \`condition\`, image_url AS imageUrl,
                     created_by AS createdBy, updated_at AS updatedAt`;

/** Reject a value that is not one of ours rather than storing it. */
function checked(value: string | undefined, allowed: readonly string[], what: string): string | null {
  if (value === undefined || value === "") return null;
  if (!allowed.includes(value)) {
    throw new RegistrationError(`Unknown ${what} "${value}". Expected one of: ${allowed.join(", ")}`);
  }
  return value;
}

export async function upsertLot(
  db: Db,
  policyId: string,
  patch: LotPatch,
  userId: number,
): Promise<void> {
  const title = patch.title?.trim() || null;
  if (title && title.length > 140) {
    throw new RegistrationError("Title is too long (140 characters maximum).");
  }
  await db.query(
    `INSERT INTO lots (policy_id, title, description, category, condition_, created_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       title       = VALUES(title),
       description = VALUES(description),
       category    = VALUES(category),
       condition_  = VALUES(condition_)`,
    [
      policyId,
      title,
      patch.description?.trim() || null,
      checked(patch.category, CATEGORIES, "category"),
      checked(patch.condition, CONDITIONS, "condition"),
      userId,
    ],
  );
}

export async function getLot(db: Db, policyId: string): Promise<Lot | undefined> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${LOT_COLUMNS} FROM lots WHERE policy_id = ?`,
    [policyId],
  );
  return rows[0] as unknown as Lot | undefined;
}

/** Every listing, keyed by policy id, for a client that wants to merge them itself. */
export async function allLots(db: Db): Promise<Record<string, Lot>> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${LOT_COLUMNS} FROM lots`);
  const out: Record<string, Lot> = {};
  for (const r of rows as unknown as Lot[]) out[r.policyId] = r;
  return out;
}

export async function setLotImage(db: Db, policyId: string, imageUrl: string): Promise<void> {
  const [res] = await db.query<ResultSetHeader>(
    `UPDATE lots SET image_url = ? WHERE policy_id = ?`,
    [imageUrl, policyId],
  );
  if (res.affectedRows === 0) {
    throw new RegistrationError("No listing for that policy id. Register the auction first.");
  }
}
