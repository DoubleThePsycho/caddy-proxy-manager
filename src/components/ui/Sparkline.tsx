import { cn } from "@/lib/utils";
import { formatCompact } from "./chart-format";

export type SparklineProps = {
  /** The series, oldest first. */
  values: readonly number[];
  /** Any CSS colour, usually a token such as "var(--served)". Default: served blue. */
  color?: string;
  /** Rendered width in px. Default 88. */
  width?: number;
  /** Rendered height in px. Default 32. */
  height?: number;
  /** Fill the area under the line (16% opacity). Default true. */
  area?: boolean;
  /**
   * What the line shows, e.g. "Requests per hour". With a label the sparkline
   * is an image whose name summarises it (lowest, highest, latest); without
   * one it is decorative and hidden from screen readers.
   */
  label?: string;
  /** Formats the summary values. Default formatCompact. */
  formatValue?: (value: number) => string;
  className?: string;
};

const VIEW_W = 96;
const VIEW_H = 32;

/** The line and area paths of a sparkline in a 96 × 32 view box. */
export function sparklinePaths(values: readonly number[]): { line: string; area: string } {
  const finite = values.map((v) => (Number.isFinite(v) ? v : 0));
  if (finite.length === 0) return { line: "", area: "" };
  const series = finite.length === 1 ? [finite[0], finite[0]] : finite;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const points = series.map((v, i) => {
    const x = (i / (series.length - 1)) * VIEW_W;
    const y = VIEW_H - 2 - (max === min ? 14 : ((v - min) / (max - min)) * 26);
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  const line = points.map((p, i) => `${i ? "L" : "M"}${p}`).join(" ");
  return { line, area: `${line} L${VIEW_W} ${VIEW_H} L0 ${VIEW_H} Z` };
}

/** A small trend line, as on the KPI tiles. */
export function Sparkline({
  values,
  color = "var(--served)",
  width = 88,
  height = 32,
  area = true,
  label,
  formatValue = formatCompact,
  className,
}: SparklineProps) {
  const { line, area: areaPath } = sparklinePaths(values);
  const finite = values.filter((v) => Number.isFinite(v));
  const summary =
    label && finite.length > 0
      ? `${label}: lowest ${formatValue(Math.min(...finite))}, highest ${formatValue(Math.max(...finite))}, latest ${formatValue(finite[finite.length - 1])}`
      : label
        ? `${label}: no data`
        : undefined;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      className={cn("shrink-0 overflow-visible", className)}
      {...(summary ? { role: "img", "aria-label": summary } : { "aria-hidden": true, focusable: false })}
    >
      {area && areaPath && <path d={areaPath} style={{ fill: color, fillOpacity: 0.16 }} />}
      {line && (
        <path
          d={line}
          style={{ fill: "none", stroke: color, strokeWidth: 1.5, strokeLinejoin: "round" }}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
