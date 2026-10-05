"use client";

/**
 * The shared body of StackedBarChart and StackedAreaChart: scales, axes,
 * hover and keyboard reading, tooltip, previous-period line, annotations,
 * legend, and the accessible table and live region. Not exported to pages;
 * use the two chart components.
 */
import { useId, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { chartScale, formatBucketTime, formatCompact, formatPercent, formatSignedChange, inferStepSeconds } from "./chart-format";

export type ChartSeries = {
  /** Stable id, used by `hidden`. */
  key: string;
  label: string;
  /** Any CSS colour, normally a token: "var(--served)", "var(--waf)", "var(--err5)"… */
  color: string;
  /** One value per bucket; missing values count as 0. */
  values: readonly number[];
  /** Area charts only: fill opacity. Default 0.22 for the first series, 0.55 above it. */
  fillOpacity?: number;
};

export type ChartAnnotation = {
  /** The bucket it marks. */
  index: number;
  /** Short text in the pill, e.g. "Peak · 1.2k mitigated". */
  label: string;
  /** Line and dot colour. Default "var(--waf)". */
  color?: string;
  /** Makes the pill a link, e.g. to the security events of that moment. */
  href?: string;
};

export type StackedChartProps = {
  /** What the chart shows ("Requests by outcome"): its accessible name and the table caption. Not drawn. */
  title: string;
  /** Bucket start times in ms since the epoch (UTC), oldest first. */
  buckets: readonly number[];
  /** Bucket width in seconds, for the default time labels. Default: from the first two buckets. */
  stepSeconds?: number;
  /** Stacked bottom to top, in this order. */
  series: readonly ChartSeries[];
  /** Totals of the previous period, one per bucket (null where unknown). */
  previous?: readonly (number | null)[];
  /** The previous period's name in the legend and tooltip. Default "Previous period". */
  previousLabel?: string;
  /** Draws the dashed previous-period line. Default: true when `previous` is given. */
  showPrevious?: boolean;
  annotations?: readonly ChartAnnotation[];
  /** Keys of hidden series (controlled). */
  hidden?: readonly string[];
  /** Keys hidden at first (uncontrolled). */
  defaultHidden?: readonly string[];
  /** Called with the new hidden keys when a legend button is pressed. */
  onHiddenChange?: (hidden: string[]) => void;
  /** Shows the legend under the chart. Default true. */
  legend?: boolean;
  /** Formats values on the axis, tooltip, legend and table. Default formatCompact. */
  formatValue?: (value: number) => string;
  /** Formats a bucket for the axis (long = false) and for the tooltip and table (long = true). Default: UTC times. */
  formatBucket?: (ms: number, long: boolean) => string;
  /** First column header of the accessible table. Default "Time (UTC)". */
  bucketHeader?: string;
  /** Plot height in px; about 70% of it on charts narrower than 24rem. Default 264 (bars) or 200 (areas). */
  height?: number;
  /** About how many x-axis labels. Default 7. */
  xTicks?: number;
  /** Shown instead of the chart when there are no buckets or every value is 0. */
  emptyText?: ReactNode;
  className?: string;
};

type Variant = "bar" | "area";

const DEFAULT_EMPTY = "No data for this period.";

function valueAt(values: readonly number[], i: number): number {
  const v = values[i];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Horizontal position (0–1) of bucket `i`: column centres for bars, edge to edge for areas. */
export function bucketPosition(variant: Variant, i: number, n: number): number {
  if (n <= 0) return 0;
  if (variant === "bar") return (i + 0.5) / n;
  return n === 1 ? 0.5 : i / (n - 1);
}

/** Indices for about `count` x-axis labels, evenly spread and including both ends. */
export function xTickIndices(n: number, count: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const k = Math.max(2, Math.min(count, n));
  const out = new Set<number>();
  for (let j = 0; j < k; j++) out.add(Math.round((j * (n - 1)) / (k - 1)));
  return [...out];
}

/**
 * The x-axis labels at each chart width: about 3 under 24rem, 4 up to 36rem
 * and `count` above, each set evenly spread on its own. Every label carries
 * the container-query classes that hide it at the widths it is not part of,
 * so narrow charts (phones) never overlap labels and nothing is measured.
 */
export function xTickLabels(n: number, count: number): { index: number; className: string }[] {
  const wide = xTickIndices(n, count);
  const medium = new Set(xTickIndices(n, Math.min(4, count)));
  const narrow = new Set(xTickIndices(n, Math.min(3, count)));
  const all = [...new Set([...wide, ...medium, ...narrow])].sort((a, b) => a - b);
  const inWide = new Set(wide);
  return all.map((index) => ({
    index,
    className: cn(!narrow.has(index) && "@max-sm:hidden", !medium.has(index) && "@sm:@max-xl:hidden", !inWide.has(index) && "@xl:hidden"),
  }));
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;

/**
 * The bucket a key moves the reading to: Right/Left step (starting from the
 * first or last), Home/End jump, Escape clears (null). Undefined for keys the
 * chart leaves alone.
 */
export function nextActiveBucket(key: string, active: number | null, n: number): number | null | undefined {
  if (n <= 0) return undefined;
  if (key === "ArrowRight") return active === null ? 0 : Math.min(n - 1, active + 1);
  if (key === "ArrowLeft") return active === null ? n - 1 : Math.max(0, active - 1);
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  if (key === "Escape") return null;
  return undefined;
}

export type ChartTooltipRow = { key: string; label: string; color: string; value: number };

/** The hover/keyboard tooltip: each series (top first), the total and the previous period with the change. */
export function ChartTooltip({
  position,
  time,
  rows,
  total,
  previous,
  previousLabel,
  formatValue,
}: {
  /** Horizontal position, 0–1; past 62% the tooltip opens to the left. */
  position: number;
  time: string;
  rows: readonly ChartTooltipRow[];
  total: number;
  previous: number | null;
  previousLabel: string;
  formatValue: (value: number) => string;
}) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-4 z-10 flex w-[232px] flex-col gap-1.5 rounded-[10px] border border-line2 bg-panel px-3 py-2.5 shadow-overlay @max-sm:left-0! @max-sm:w-full! @max-sm:transform-none!"
      style={{ left: pct(position), transform: position > 0.62 ? "translateX(calc(-100% - 14px))" : "translateX(14px)" }}
      data-testid="chart-tooltip"
    >
      <div className="num text-xs text-muted-foreground">{time}</div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2 text-[13px]">
          <span className="size-2 flex-none rounded-[2px]" style={{ background: r.color }} />
          <span className="flex-1 truncate">{r.label}</span>
          <span className="num">{formatValue(r.value)}</span>
        </div>
      ))}
      <div className="flex border-t border-line pt-1.5 text-[13px] font-semibold">
        <span className="flex-1">Total</span>
        <span className="num">{formatValue(total)}</span>
      </div>
      {previous !== null && (
        <div className="flex gap-2 text-xs text-muted-foreground">
          <span className="flex-1">{previousLabel}</span>
          <span className="num">{formatValue(previous)}</span>
          <span className="num text-foreground">{formatSignedChange(total, previous)}</span>
        </div>
      )}
    </div>
  );
}

/** What the live region says for a bucket: its time, each series (top first), the total and the previous period. */
export function chartAnnouncement(
  time: string,
  rows: readonly ChartTooltipRow[],
  total: number,
  previous: number | null,
  previousLabel: string,
  formatValue: (value: number) => string
): string {
  return (
    `${time}: ${rows.map((r) => `${r.label} ${formatValue(r.value)}`).join(", ")}. Total ${formatValue(total)}.` +
    (previous !== null ? ` ${previousLabel} ${formatValue(previous)}.` : "")
  );
}

export function StackedChartBase({
  variant,
  title,
  buckets,
  stepSeconds,
  series,
  previous,
  previousLabel = "Previous period",
  showPrevious,
  annotations = [],
  hidden: hiddenProp,
  defaultHidden = [],
  onHiddenChange,
  legend = true,
  formatValue = formatCompact,
  formatBucket,
  bucketHeader = "Time (UTC)",
  height,
  xTicks = 7,
  emptyText = DEFAULT_EMPTY,
  className,
}: StackedChartProps & { variant: Variant }) {
  const id = useId();
  const [hiddenState, setHiddenState] = useState<readonly string[]>(defaultHidden);
  const [active, setActive] = useState<number | null>(null);
  const hidden = new Set(hiddenProp ?? hiddenState);
  const step = stepSeconds ?? inferStepSeconds(buckets);
  const label = formatBucket ?? ((ms: number, long: boolean) => formatBucketTime(ms, step, long) + (long ? " UTC" : ""));
  const n = buckets.length;
  const plotHeight = height ?? (variant === "bar" ? 264 : 200);

  const visible = series.filter((s) => !hidden.has(s.key));
  const totals = Array.from({ length: n }, (_, i) => visible.reduce((sum, s) => sum + valueAt(s.values, i), 0));
  const prevShown = Boolean(previous) && (showPrevious ?? true);
  const prev = Array.from({ length: n }, (_, i) => {
    const v = previous?.[i];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  });
  const grandTotal = series.reduce((sum, s) => sum + Array.from({ length: n }, (_, i) => valueAt(s.values, i)).reduce((a, b) => a + b, 0), 0);
  const empty = n === 0 || series.length === 0 || grandTotal === 0;

  const toggle = (key: string) => {
    const next = hidden.has(key) ? [...hidden].filter((k) => k !== key) : [...hidden, key];
    if (hiddenProp === undefined) setHiddenState(next);
    onHiddenChange?.(next);
  };

  if (empty) {
    return (
      <div className={cn("flex min-h-24 items-center justify-center rounded-lg border border-dashed border-line px-4 py-8 text-center text-[13px] text-soft", className)}>
        <p className="m-0">{emptyText}</p>
      </div>
    );
  }

  const scale = chartScale([...totals, ...(prevShown ? prev.filter((v): v is number => v !== null) : [])]);
  const yMax = scale.max;
  const pos = (i: number) => bucketPosition(variant, i, n);
  const visibleTotal = totals.reduce((a, b) => a + b, 0);

  const onMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const i = variant === "bar" ? Math.min(n - 1, Math.floor(x * n)) : Math.round(x * (n - 1));
    if (i !== active) setActive(i);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextActiveBucket(event.key, active, n);
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  };

  const rowsAt = (i: number): ChartTooltipRow[] => visible.slice().reverse().map((s) => ({ key: s.key, label: s.label, color: s.color, value: valueAt(s.values, i) }));
  const announcement =
    active === null
      ? ""
      : chartAnnouncement(label(buckets[active], true), rowsAt(active), totals[active], prevShown ? prev[active] : null, previousLabel, formatValue);

  const prevPath = prevShown
    ? prev
        .map((v, i) => (v === null ? null : { x: pos(i) * 1000, y: Math.max(0, 100 - (v / yMax) * 100) }))
        .reduce<string[]>((parts, p, i, all) => {
          if (!p) return parts;
          parts.push(`${i === 0 || !all[i - 1] ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(2)}`);
          return parts;
        }, [])
        .join(" ")
    : "";

  const hintId = `${id}-hint`;
  const ticks = xTickLabels(n, xTicks);

  return (
    <div className={cn("@container relative flex min-w-0 flex-col gap-3.5", className)}>
      <div className="relative pl-[52px]">
        <div
          role="group"
          aria-roledescription="chart"
          aria-label={title}
          aria-describedby={hintId}
          tabIndex={0}
          // Narrow charts (phones) get a shorter plot so the shape stays readable.
          className="relative h-(--plot-h) cursor-crosshair rounded-sm @max-sm:h-[calc(var(--plot-h)*0.72)]"
          style={{ "--plot-h": `${plotHeight}px` } as CSSProperties}
          onMouseMove={onMouseMove}
          onMouseLeave={() => setActive(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          data-testid="chart-plot"
        >
          {scale.ticks.map((tick, k) => (
            <div key={k} aria-hidden="true" className="absolute inset-x-0 border-t border-line" style={{ bottom: pct(tick / yMax) }}>
              <span className="num absolute right-[calc(100%+10px)] -top-[9px] whitespace-nowrap text-[11px] text-soft">
                {k === 0 ? "0" : formatValue(tick)}
              </span>
            </div>
          ))}

          {variant === "bar" ? (
            <div aria-hidden="true" className="absolute inset-0 flex items-stretch" style={{ gap: n > 50 ? 1 : 2 }}>
              {buckets.map((_, i) => (
                <div
                  key={i}
                  data-bucket={i}
                  className={cn("flex min-w-0 flex-1 flex-col-reverse rounded-[2px]", active === i && "bg-brand-tint")}
                >
                  {visible.map((s) => {
                    const v = valueAt(s.values, i);
                    if (v <= 0) return null;
                    return <div key={s.key} data-series={s.key} className="flex-none" style={{ height: pct(v / yMax), background: s.color }} />;
                  })}
                </div>
              ))}
            </div>
          ) : (
            <AreaLayers series={visible} n={n} yMax={yMax} />
          )}

          {variant === "area" && active !== null && (
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l border-line2" style={{ left: pct(pos(active)) }}>
              {visible.reduce<{ key: string; color: string; top: number }[]>((dots, s) => {
                const below = dots.length ? dots[dots.length - 1].top : 0;
                dots.push({ key: s.key, color: s.color, top: below + valueAt(s.values, active) });
                return dots;
              }, []).map((dot) => (
                <span
                  key={dot.key}
                  className="absolute size-2 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-panel"
                  style={{ bottom: pct(dot.top / yMax), left: 0, background: dot.color }}
                />
              ))}
            </div>
          )}

          {annotations
            .filter((a) => a.index >= 0 && a.index < n)
            .map((a, k) => {
              const color = a.color ?? "var(--waf)";
              // In the right part of the chart the pill opens to the left of its line, so it stays inside the card.
              const pillSide = pos(a.index) > 0.6 ? "right-1.5" : "left-1.5";
              const pillClass = cn(
                "pointer-events-auto absolute -top-0.5 flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line2 bg-panel2 px-2 py-0.5 text-xs text-foreground no-underline",
                pillSide
              );
              const pill = (
                <>
                  <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: color }} />
                  {a.label}
                </>
              );
              return (
                <div
                  key={k}
                  className="pointer-events-none absolute inset-y-0"
                  style={{ left: pct(pos(a.index)), borderLeft: `1px dashed ${color}` }}
                  data-annotation={a.index}
                >
                  {a.href ? (
                    <Link href={a.href} className={cn(pillClass, "hover:bg-raise")}>
                      {pill}
                    </Link>
                  ) : (
                    <span className={pillClass}>{pill}</span>
                  )}
                </div>
              );
            })}

          {prevShown && prevPath && (
            <svg
              aria-hidden="true"
              viewBox="0 0 1000 100"
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-0 size-full overflow-visible"
              data-testid="chart-previous"
            >
              <path
                d={prevPath}
                vectorEffect="non-scaling-stroke"
                style={{ fill: "none", stroke: "var(--foreground)", strokeOpacity: 0.6, strokeWidth: 1.5, strokeDasharray: "5 4" }}
              />
            </svg>
          )}

          {active !== null && (
            <ChartTooltip
              position={pos(active)}
              time={label(buckets[active], true)}
              rows={rowsAt(active)}
              total={totals[active]}
              previous={prevShown ? prev[active] : null}
              previousLabel={previousLabel}
              formatValue={formatValue}
            />
          )}
        </div>

        <div aria-hidden="true" className="relative mt-2 h-[18px]">
          {ticks.map(({ index: i, className: tickClass }) => {
            const p = pos(i);
            return (
              <span
                key={i}
                className={cn("num absolute whitespace-nowrap text-[11px] text-soft", tickClass)}
                style={{ left: pct(p), transform: p < 0.02 ? "none" : p > 0.98 ? "translateX(-100%)" : "translateX(-50%)" }}
              >
                {label(buckets[i], false)}
              </span>
            );
          })}
        </div>
      </div>

      <p id={hintId} className="sr-only">
        Use the left and right arrow keys to read each period. The table after the chart lists every value.
      </p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {legend && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2.5">
          {series.map((s) => {
            const on = !hidden.has(s.key);
            const total = Array.from({ length: n }, (_, i) => valueAt(s.values, i)).reduce((a, b) => a + b, 0);
            return (
              <button
                key={s.key}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(s.key)}
                className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors hover:bg-raise", !on && "opacity-45")}
              >
                <span aria-hidden="true" className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
                <span>{s.label}</span>
                <span className="num text-muted-foreground">{formatValue(total)}</span>
                <span className="num text-xs text-soft">{on ? formatPercent(visibleTotal ? total / visibleTotal : 0) : "hidden"}</span>
              </button>
            );
          })}
          {prevShown && (
            <span className="ml-auto flex items-center gap-2 text-[13px] text-muted-foreground">
              <svg width="20" height="4" viewBox="0 0 20 4" aria-hidden="true">
                <path d="M0 2h20" style={{ stroke: "var(--foreground)", strokeOpacity: 0.6, strokeWidth: 1.5, strokeDasharray: "5 4" }} />
              </svg>
              {previousLabel}
            </span>
          )}
        </div>
      )}

      {/* The hidden div clips the table: a table is as wide as its content whatever its own width. */}
      <div className="sr-only">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">{bucketHeader}</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
              <th scope="col">Total</th>
              {previous && <th scope="col">{previousLabel}</th>}
            </tr>
          </thead>
          <tbody>
            {buckets.map((ms, i) => (
              <tr key={i}>
                <th scope="row">{label(ms, true)}</th>
                {series.map((s) => (
                  <td key={s.key}>{formatValue(valueAt(s.values, i))}</td>
                ))}
                <td>{formatValue(series.reduce((sum, s) => sum + valueAt(s.values, i), 0))}</td>
                {previous && <td>{prev[i] === null ? "–" : formatValue(prev[i] as number)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Stacked areas (bottom to top) with a line on top of each, in a 1000 × 100 view box. */
function AreaLayers({ series, n, yMax }: { series: readonly ChartSeries[]; n: number; yMax: number }) {
  const x = (i: number) => (bucketPosition("area", i, n) * 1000).toFixed(1);
  const y = (v: number) => Math.max(0, 100 - (v / yMax) * 100).toFixed(2);
  const base = new Array<number>(n).fill(0);
  const layers = series.map((s, index) => {
    const lower = base.slice();
    const upper = lower.map((b, i) => b + valueAt(s.values, i));
    for (let i = 0; i < n; i++) base[i] = upper[i];
    const top = upper.map((v, i) => `${i ? "L" : "M"}${x(i)} ${y(v)}`).join(" ");
    const bottom = lower
      .map((v, i) => ({ v, i }))
      .reverse()
      .map(({ v, i }) => `L${x(i)} ${y(v)}`)
      .join(" ");
    return { key: s.key, color: s.color, opacity: s.fillOpacity ?? (index === 0 ? 0.22 : 0.55), area: `${top} ${bottom} Z`, line: top };
  });
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1000 100"
      preserveAspectRatio="none"
      className="absolute inset-0 size-full overflow-visible"
      data-testid="chart-areas"
    >
      {layers.map((l) => (
        <path key={`a-${l.key}`} data-series={l.key} d={l.area} style={{ fill: l.color, fillOpacity: l.opacity }} />
      ))}
      {layers.map((l) => (
        <path key={`l-${l.key}`} d={l.line} vectorEffect="non-scaling-stroke" style={{ fill: "none", stroke: l.color, strokeWidth: 1.5, strokeLinejoin: "round" }} />
      ))}
    </svg>
  );
}
