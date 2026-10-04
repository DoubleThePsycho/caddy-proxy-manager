import type { ReactNode } from "react";
import Link from "next/link";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCompact, formatPercent } from "./chart-format";

export type TopListRow = {
  /** Stable React key. */
  key: string;
  /** What the row is: a host, path, country name, user agent… */
  label: string;
  /** The value a filter on this row uses (and its aria labels name). Default: `code` when given, else `label`. */
  value?: string;
  /** Count for the row (requests, events…). */
  count: number;
  /** Secondary text after the label ("IT · status monitor"). */
  sub?: string;
  /** A short code shown in a badge before the label ("IT", "LAN"). */
  code?: string;
  /** A warning tag after the label ("16% blocked", "scanner"). */
  tag?: string;
  /** A colour square before the label, e.g. the status class colour "var(--err5)". */
  dot?: string;
  /** Makes the label a link. */
  href?: string;
};

export type TopListSegment = {
  label: string;
  /** Share of the whole, 0–1. */
  fraction: number;
  /** CSS colour, e.g. "var(--served)". */
  color: string;
};

export type TopListProps = {
  /** Panel heading ("Hosts"). Omit to render the list without a heading row. */
  title?: ReactNode;
  /** Heading element. Default "h3". */
  titleAs?: "h2" | "h3" | "h4";
  /** What the counts are, shown at the right of the heading ("Requests"). */
  unit?: ReactNode;
  /** The dimension's name for filter labels ("Host" gives "Filter: Host is x"). Default: the title when it is a string. */
  dimension?: string;
  rows: readonly TopListRow[];
  /** Denominator of the share column. Default: the sum of the rows. */
  total?: number;
  /** Labels in mono (paths, addresses, codes). Default false. */
  mono?: boolean;
  /** Formats counts. Default formatCompact. */
  formatCount?: (value: number) => string;
  /**
   * Width of the count column, as a CSS length ("96px", "8ch") or pixels.
   * Default: wide enough for the longest formatted count (at least 52px),
   * the same on every row so the columns line up.
   */
  countWidth?: number | string;
  /** Shows a + button on hover/focus that filters to the row. */
  onInclude?: (row: TopListRow) => void;
  /** Shows a − button on hover/focus that excludes the row. */
  onExclude?: (row: TopListRow) => void;
  /** A share bar above the list (status classes 2xx/3xx/4xx/5xx). */
  segments?: readonly TopListSegment[];
  /** Shown when there are no rows. Default "Nothing matches the filters." */
  emptyText?: ReactNode;
  /** A "View all" link under the list. */
  moreHref?: string;
  /** Text of that link. Default "View all". */
  moreLabel?: ReactNode;
  /** Draw the panel's card (background, border, radius). Default true. */
  framed?: boolean;
  className?: string;
};

/**
 * A ranked list of one dimension's values, as in the analytics page's top
 * dimensions: each row with a share bar behind it, its count and share of
 * the total, and on hover + / − buttons to filter on it or exclude it.
 */
export function TopList({
  title,
  titleAs: Heading = "h3",
  unit,
  dimension,
  rows,
  total,
  mono = false,
  formatCount = formatCompact,
  countWidth,
  onInclude,
  onExclude,
  segments,
  emptyText = "Nothing matches the filters.",
  moreHref,
  moreLabel = "View all",
  framed = true,
  className,
}: TopListProps) {
  const name = dimension ?? (typeof title === "string" ? title : "Value");
  const largest = Math.max(1, ...rows.map((r) => r.count));
  const denominator = total ?? rows.reduce((sum, r) => sum + r.count, 0);
  // Counts are in mono with tabular figures, so 1ch is one character: the
  // column fits the longest count (money amounts, "1,234,567") on every row.
  const longest = rows.reduce((max, r) => Math.max(max, formatCount(r.count).length), 0);
  const countColumn =
    countWidth !== undefined
      ? { width: typeof countWidth === "number" ? `${countWidth}px` : countWidth }
      : { width: `max(52px, ${longest + 0.5}ch)` };
  return (
    <section className={cn("flex min-w-0 flex-col", framed && "rounded-xl border border-line bg-panel", className)}>
      {(title || unit) && (
        <div className="flex items-center gap-2 px-3.5 pb-2 pt-3">
          {title && <Heading className="m-0 flex-1 text-sm font-semibold">{title}</Heading>}
          {unit && <span className="ml-auto text-xs text-soft">{unit}</span>}
        </div>
      )}
      {segments && segments.length > 0 && (
        <div className="flex flex-col gap-1.5 px-3.5 pb-2.5">
          <div className="flex h-2 gap-0.5 overflow-hidden rounded" aria-hidden="true">
            {segments.map((s) => (
              <div key={s.label} style={{ width: `${(Math.max(0, s.fraction) * 100).toFixed(1)}%`, background: s.color }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {segments.map((s) => (
              <span key={s.label} className="flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: s.color }} />
                {s.label} <span className="num">{formatPercent(s.fraction)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="m-0 px-3.5 pb-4 pt-1 text-[13px] text-soft">{emptyText}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-px px-1.5 pb-1.5">
          {rows.map((row) => {
            const value = row.value ?? row.code ?? row.label;
            const width = `${((row.count / largest) * 100).toFixed(1)}%`;
            const labelClass = cn("truncate text-[13px]", mono && "num");
            return (
              <li
                key={row.key}
                className="group relative flex h-[34px] items-center gap-2 overflow-hidden rounded-lg px-2 hover:bg-panel2"
              >
                <span
                  aria-hidden="true"
                  data-share={width}
                  className="pointer-events-none absolute inset-y-1 left-0 rounded-md bg-brand-tint"
                  style={{ width }}
                />
                <span className="relative flex min-w-0 flex-1 items-center gap-2">
                  {row.dot && <span aria-hidden="true" className="size-2 flex-none rounded-[2px]" style={{ background: row.dot }} />}
                  {row.code && (
                    <span className="num flex-none rounded bg-raise px-[5px] text-[11px] font-semibold leading-[18px] text-muted-foreground">
                      {row.code}
                    </span>
                  )}
                  {row.href ? (
                    <Link href={row.href} className={cn(labelClass, "text-foreground hover:text-brand")}>
                      {row.label}
                    </Link>
                  ) : (
                    <span className={labelClass}>{row.label}</span>
                  )}
                  {row.sub && <span className="truncate text-xs text-soft">{row.sub}</span>}
                  {row.tag && (
                    <span className="flex-none whitespace-nowrap rounded-full bg-warn-tint px-1.5 text-[11px] font-semibold leading-[18px] text-warn">
                      {row.tag}
                    </span>
                  )}
                </span>
                {(onInclude || onExclude) && (
                  <span className="relative flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    {onInclude && (
                      <button
                        type="button"
                        aria-label={`Filter: ${name} is ${value}`}
                        title="Filter to this"
                        onClick={() => onInclude(row)}
                        className="grid size-6 cursor-pointer place-items-center rounded-md border border-line2 bg-panel text-foreground hover:bg-raise"
                      >
                        <Plus aria-hidden="true" className="size-3" strokeWidth={2.6} />
                      </button>
                    )}
                    {onExclude && (
                      <button
                        type="button"
                        aria-label={`Exclude: ${name} is ${value}`}
                        title="Exclude this"
                        onClick={() => onExclude(row)}
                        className="grid size-6 cursor-pointer place-items-center rounded-md border border-line2 bg-panel text-foreground hover:bg-raise"
                      >
                        <Minus aria-hidden="true" className="size-3" strokeWidth={2.6} />
                      </button>
                    )}
                  </span>
                )}
                <span className="num relative flex-none whitespace-nowrap text-right text-[13px]" style={countColumn}>
                  {formatCount(row.count)}
                </span>
                <span className="num relative w-12 flex-none text-right text-xs text-soft">
                  {formatPercent(denominator > 0 ? row.count / denominator : 0)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {moreHref && rows.length > 0 && (
        <div className="mt-auto border-t border-line px-3.5 pb-2.5 pt-2">
          <Link href={moreHref} className="text-[13px] text-brand hover:text-foreground">
            {moreLabel}
          </Link>
        </div>
      )}
    </section>
  );
}
