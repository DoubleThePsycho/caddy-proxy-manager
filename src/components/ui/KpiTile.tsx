import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Sparkline } from "./Sparkline";
import type { DeltaTone } from "./chart-format";

export type KpiDelta = {
  /** "▲ 12%", "▼ 33%", "up from 0"… formatChange() in chart-format builds one. */
  text: string;
  /** ok: a good change (green), bad: a bad one (red), neutral (secondary text). Default neutral. */
  tone?: DeltaTone;
};

export type KpiTileProps = {
  label: ReactNode;
  /** The figure, already formatted ("61,817", "1.24 GB", "0.23%"). Shown in mono. */
  value: ReactNode;
  /** The series colour for the swatch and sparkline, e.g. "var(--waf)". No swatch when absent. */
  color?: string;
  /** The change against the previous period. */
  delta?: KpiDelta;
  /** Text after the delta ("vs previous 24 hours", "1.8% of requests"). */
  note?: ReactNode;
  /** A trend line on the right of the value, left out where the tile is too narrow for it. */
  sparkline?: readonly number[];
  /** Selected tile (accent border and tint). Only meaningful with onSelect. */
  selected?: boolean;
  /** Makes the tile a toggle button (aria-pressed = selected), as on the analytics page. */
  onSelect?: () => void;
  /** Makes the tile a link instead (ignored when onSelect is given). */
  href?: string;
  /** "md" (default): 26px value; "sm": 20px value and tighter padding, for rows of many tiles or side panels. */
  size?: "sm" | "md";
  className?: string;
};

export const DELTA_TONE_CLASS: Record<DeltaTone, string> = {
  ok: "text-ok",
  bad: "text-bad",
  neutral: "text-muted-foreground",
};

/** A headline figure: label, big mono value, optional trend and change. Static, a link or a toggle. */
export function KpiTile({ label, value, color, delta, note, sparkline, selected = false, onSelect, href, size = "md", className }: KpiTileProps) {
  const small = size === "sm";
  const body = (
    <>
      <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
        {color && <span aria-hidden="true" className="size-2 shrink-0 rounded-[2px]" style={{ background: color }} />}
        <span className="min-w-0 truncate">{label}</span>
      </span>
      <span className="flex items-end justify-between gap-2">
        <span
          className={cn(
            "num whitespace-nowrap font-medium tracking-[-0.02em] text-foreground",
            small ? "text-[20px] leading-7" : "text-[26px] leading-8"
          )}
        >
          {value}
        </span>
        {sparkline && sparkline.length > 0 && (
          // Takes the room the value leaves and drops the line where that is narrower than the line (narrow tiles, phones).
          <span className="@container flex min-w-0 flex-1 justify-end" data-testid="kpi-sparkline">
            <Sparkline values={sparkline} color={color ?? "var(--served)"} className="@max-[5.5rem]:hidden" />
          </span>
        )}
      </span>
      {(delta || note) && (
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-soft">
          {delta && <span className={cn("num font-semibold", DELTA_TONE_CLASS[delta.tone ?? "neutral"])}>{delta.text}</span>}
          {note && <span>{note}</span>}
        </span>
      )}
    </>
  );
  const frame = cn(
    "flex min-w-0 flex-col rounded-xl border text-left",
    small ? "gap-1 px-3.5 py-3" : "gap-1.5 px-4 py-3.5",
    selected ? "border-brand bg-brand-tint" : "border-line bg-panel",
    className
  );
  if (onSelect) {
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(frame, "cursor-pointer transition-colors", !selected && "hover:border-line2 hover:bg-panel2")}
      >
        {body}
      </button>
    );
  }
  if (href) {
    return (
      <Link href={href} className={cn(frame, "transition-colors hover:border-line2 hover:bg-panel2")}>
        {body}
      </Link>
    );
  }
  return <div className={frame}>{body}</div>;
}
