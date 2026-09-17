/**
 * Listings: the operator's description of the goods.
 *
 * Fetched separately from `/auctions` and merged in the interface, rather than
 * arriving pre-joined in one object. That is deliberate. The read model is a
 * projection of the chain; this is a projection of whatever the seller typed
 * into a form. Delivering them as two responses keeps the boundary visible
 * instead of blurring it into one blob where a reader cannot tell which half a
 * ledger guarantees and which half is somebody's word.
 *
 * The interface makes the same distinction visually: a title and a photograph
 * are shown as description, and every figure that matters -- the standing bid,
 * the deadline, the winner -- is shown with a link to a public explorer.
 */
import type { AuctionSummary } from "./api.ts";

export interface Lot {
  policyId: string;
  title: string | null;
  description: string | null;
  category: string | null;
  condition: string | null;
  /** A path under /uploads, or null when the seller uploaded no photograph. */
  imageUrl: string | null;
  createdBy: number | null;
  updatedAt: string;
}

/** An auction and what the operator says is in the box. */
export interface Listing extends AuctionSummary {
  item: Lot | null;
}

export interface LotPatch {
  title?: string;
  description?: string;
  category?: string;
  condition?: string;
}

/** What the sell flow posts once both of its transactions have confirmed. */
export interface ListingSubmission {
  params: {
    apSeller: string;
    apCurrencySymbol: string;
    apTokenName: string;
    apMinBid: string;
    apEndTime: string;
  };
  lot: {
    seed: { txHash: string; outputIndex: number };
    sellerPkh: string;
    tokenNameHex: string;
  };
  tokenName: string;
  openTxHash: string;
  meta?: LotPatch;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: init.body instanceof FormData
      ? { ...init.headers }
      : { "content-type": "application/json", ...init.headers },
  });
  // Read as text first: a dev server that has not been told to proxy this path
  // answers 200 with index.html, and parsing that as JSON fails somewhere
  // unrelated. Failing here names the actual problem.
  const raw = await res.text();
  let body: (T & { error?: string }) | null = null;
  try {
    body = JSON.parse(raw) as T & { error?: string };
  } catch {
    if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.statusText}`);
    throw new Error(
      `${path} did not return JSON. If this is the Vite dev server, add the path to ` +
        `the proxy in vite.config.ts.`,
    );
  }
  if (!res.ok) throw new Error(body?.error ?? `Request failed: ${res.status}`);
  if (body === null) throw new Error(`${path} returned an empty body.`);
  return body;
}

export interface LotsResponse {
  lots: Record<string, Lot>;
  categories: string[];
  conditions: string[];
}

export const allLots = () => call<LotsResponse>("/lots");

/** Register a freshly opened auction so the indexer starts watching it. */
export const registerListing = (sub: ListingSubmission) =>
  call<{ ok: true; lot: Lot | null }>("/lots", { method: "POST", body: JSON.stringify(sub) });

export const saveLot = (policyId: string, patch: LotPatch) =>
  call<Lot>(`/lots/${policyId}`, { method: "PUT", body: JSON.stringify(patch) });

/** Upload a photograph. The server sniffs the bytes; the declared type is ignored. */
export function uploadImage(policyId: string, file: File) {
  const form = new FormData();
  form.append("image", file);
  return call<{ url: string; sha256: string; type: string }>(
    `/lots/${policyId}/image`,
    { method: "POST", body: form },
  );
}

/** Join what the chain says with what the operator says. Chain data wins on conflict. */
export function merge(auctions: AuctionSummary[], lots: Record<string, Lot>): Listing[] {
  return auctions.map((a) => ({ ...a, item: lots[a.policyId] ?? null }));
}
