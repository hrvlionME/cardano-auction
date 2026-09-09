/**
 * The read model, as the browser sees it.
 *
 * These types mirror what `off-chain/src/indexer/api.ts` returns. Nothing here
 * is trusted for anything that matters: the page uses it to *display* auctions,
 * and every number that ends up in a transaction is re-read from the chain when
 * the transaction is built. If this server lies, the page shows the wrong
 * price -- it cannot make anyone pay it.
 */
export interface Leader {
  address: string | null;
  /** Chosen display name, when this site knows one. Decoration over the address. */
  name: string | null;
  amountLovelace: number | null;
  txHash: string;
  at: string;
}

export interface AuctionEvent {
  kind: "open" | "bid" | "settle";
  txHash: string;
  outputIndex: number | null;
  blockHeight: number;
  at: string;
  bidderAddress: string | null;
  bidderName: string | null;
  amountLovelace: number | null;
  datum: string | null;
}

export interface AuctionSummary {
  policyId: string;
  tokenName: string;
  unit: string;
  address: string;
  sellerAddress: string;
  minBidLovelace: number;
  endTime: number;
  endTimeIso: string;
  phase: "bidding" | "closed" | "settled";
  bidCount: number;
  leader: Leader | null;
  nextBidMustExceedLovelace: number;
  /** Minting-policy parameters, needed to burn the token. Public chain data. */
  lot: {
    seed: { txHash: string; outputIndex: number };
    sellerPkh: string;
    tokenNameHex: string;
  } | null;
}

export interface AuctionDetail extends AuctionSummary {
  events: AuctionEvent[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return await res.json() as T;
}

export async function listAuctions(): Promise<AuctionSummary[]> {
  const { auctions } = await get<{ auctions: AuctionSummary[] }>("/auctions");
  return auctions;
}

export function getAuction(policyId: string): Promise<AuctionDetail> {
  return get<AuctionDetail>(`/auctions/${policyId}`);
}

export const ada = (lovelace: number | bigint | null | undefined): string =>
  lovelace === null || lovelace === undefined
    ? "--"
    : (Number(lovelace) / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    });
