/** Small presentational pieces shared across pages. No logic that decides anything. */
import { type ReactNode, useEffect, useState } from "react";
import { countdown, label } from "./format.ts";
import type { Lot } from "./lots.ts";

export function Spinner() {
  return <span className="spin" aria-hidden="true" />;
}

export function Notice(
  { kind = "info", children }: { kind?: "info" | "ok" | "err" | "warn"; children: ReactNode },
) {
  return <div className={`notice ${kind}`} role={kind === "err" ? "alert" : "status"}>{children}</div>;
}

/** Ticks once a second. Rendered wherever a deadline is shown. */
export function Countdown({ endTime }: { endTime: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{countdown(endTime - now)}</>;
}

export function Phase({ phase }: { phase: "bidding" | "closed" | "settled" }) {
  const text = phase === "bidding" ? "live" : phase === "closed" ? "ended" : "settled";
  return <span className={`phase ${phase}`}>{text}</span>;
}

/**
 * The item's photograph, or a placeholder built from its token name.
 *
 * A lot with no photograph is the normal state for anything minted from the
 * command line, so the placeholder has to look deliberate rather than broken.
 * The initials come from the token name, which is the one thing every lot has.
 */
export function LotImage(
  { item, tokenName, className = "" }: { item: Lot | null; tokenName: string; className?: string },
) {
  const [failed, setFailed] = useState(false);

  if (item?.imageUrl && !failed) {
    return (
      <img
        className={`lotimg ${className}`}
        src={item.imageUrl}
        alt={item.title ?? tokenName}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div className={`lotimg placeholder ${className}`} aria-hidden="true">
      <span>{tokenName.slice(0, 2).toUpperCase()}</span>
    </div>
  );
}

/** Category and condition, when the seller supplied them. */
export function Tags({ item }: { item: Lot | null }) {
  if (!item?.category && !item?.condition) return null;
  return (
    <div className="tags">
      {item.category && <span className="tag">{label(item.category)}</span>}
      {item.condition && <span className="tag subtle">{label(item.condition)}</span>}
    </div>
  );
}

/** A dismissable dialog. Escape closes it, which is what anyone tries first. */
export function Modal(
  { title, onClose, children }: { title: string; onClose: () => void; children: ReactNode },
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        {children}
      </div>
    </div>
  );
}

/** A labelled figure: the unit of every statistics row in the app. */
export function Figure(
  { label: text, value, note }: { label: string; value: ReactNode; note?: ReactNode },
) {
  return (
    <div className="figure">
      <div className="label">{text}</div>
      <div className="value">{value}</div>
      {note !== undefined && <div className="note">{note}</div>}
    </div>
  );
}
