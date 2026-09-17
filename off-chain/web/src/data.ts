/**
 * Reading the two projections and joining them.
 *
 * Polling rather than a socket, because the thing being watched is a
 * blockchain: state changes when a block is minted, roughly every twenty
 * seconds on Preview, and nothing is gained by asking faster than that. The one
 * exception is while a transaction of the user's own is in flight, which is the
 * only moment somebody is actually waiting on the answer.
 */
import { useCallback, useEffect, useState } from "react";
import { type AuctionDetail, type AuctionSummary, getAuction, listAuctions } from "./api.ts";
import { allLots, type Listing, type Lot, merge } from "./lots.ts";

const POLL_MS = 8_000;
const POLL_MS_PENDING = 3_000;

interface Feed<T> {
  data: T | null;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Every auction, merged with whatever the operator says is in the box. */
export function useListings(pending = false): Feed<Listing[]> & { categories: string[] } {
  const [data, setData] = useState<Listing[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // In parallel: they are independent, and the chain projection must not
      // wait on the operator's one. A failure in either is reported the same
      // way -- but note the merge below tolerates missing metadata entirely,
      // because an auction with no description is still a real auction.
      const [auctions, lots] = await Promise.all([listAuctions(), allLots()]);
      setData(merge(auctions, lots.lots));
      setCategories(lots.categories);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), pending ? POLL_MS_PENDING : POLL_MS);
    return () => clearInterval(id);
  }, [refresh, pending]);

  return { data, error, refresh, categories };
}

export interface ListingDetail extends AuctionDetail {
  item: Lot | null;
}

/** One auction, with its history and its description. */
export function useListing(
  policyId: string | undefined,
  pending = false,
): Feed<ListingDetail> & { vocabulary: { categories: string[]; conditions: string[] } } {
  const [data, setData] = useState<ListingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The accepted categories and conditions come from the server rather than
  // being repeated here. They are validated server-side, and a second copy in
  // the browser is a second thing to keep in step.
  const [vocabulary, setVocabulary] = useState({ categories: [] as string[], conditions: [] as string[] });

  const refresh = useCallback(async () => {
    if (!policyId) return;
    try {
      const [detail, lots] = await Promise.all([getAuction(policyId), allLots()]);
      setData({ ...detail, item: lots.lots[policyId] ?? null });
      setVocabulary({ categories: lots.categories, conditions: lots.conditions });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [policyId]);

  useEffect(() => {
    setData(null);
    void refresh();
    const id = setInterval(() => void refresh(), pending ? POLL_MS_PENDING : POLL_MS);
    return () => clearInterval(id);
  }, [refresh, pending]);

  return { data, error, refresh, vocabulary };
}

/** Sort for the browse grid: live auctions first, then by how soon they close. */
export function forDisplay(rows: Listing[]): Listing[] {
  const rank = { bidding: 0, closed: 1, settled: 2 };
  return [...rows].sort((a, b) =>
    rank[a.phase] - rank[b.phase] ||
    (a.phase === "bidding" ? a.endTime - b.endTime : b.endTime - a.endTime)
  );
}

/** Free-text match over the fields a person would actually search by. */
export function matches(l: Listing, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [l.tokenName, l.item?.title, l.item?.description, l.item?.category, l.policyId]
    .some((f) => f?.toLowerCase().includes(needle));
}

export type { AuctionSummary };
