/** Small display helpers shared by every page. Nothing here decides anything. */

/** Lovelace to a readable ADA figure. */
export const ada = (lovelace: number | bigint | null | undefined): string =>
  lovelace === null || lovelace === undefined
    ? "--"
    : (Number(lovelace) / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    });

/**
 * Abbreviate a long hex string or bech32 address for display.
 *
 * The full value always goes in a `title` attribute or an explorer link
 * alongside: an abbreviated address is for reading, never for checking.
 */
export function short(value: string | null | undefined, head = 12, tail = 6): string {
  if (!value) return "--";
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** "2d 04:11:38" or "04:11:38". Empty once the deadline has passed. */
export function countdown(msLeft: number): string {
  if (msLeft <= 0) return "closed";
  const s = Math.floor(msLeft / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(Math.floor(s % 86400 / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
  const d = Math.floor(s / 86400);
  return d > 0 ? `${d}d ${clock}` : clock;
}

const TITLE_CASE: Record<string, string> = {
  "like-new": "Like new",
  "for-parts": "For parts",
};

/** A stored slug as a label: "like-new" -> "Like new", "art" -> "Art". */
export const label = (slug: string | null | undefined): string =>
  !slug ? "" : TITLE_CASE[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
