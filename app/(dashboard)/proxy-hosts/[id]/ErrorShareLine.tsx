"use client";

/**
 * The share of 5xx responses per bucket as a thin line under the host's
 * request chart, with the error-rate alert threshold as a dashed line when a
 * rule watches the host. An image for screen readers, named with its
 * highest value; the request chart above carries the data table.
 */
import { niceMax, formatBucketTime } from "@/components/ui/chart-format";

type Props = {
  /** Bucket start times, ms. */
  buckets: readonly number[];
  stepSeconds: number;
  requests: readonly number[];
  errors: readonly number[];
  /** The alert threshold in percent, if a rule watches the host. */
  thresholdPercent: number | null;
};

const VIEW_W = 1000;
const VIEW_H = 56;

function percentText(value: number): string {
  return `${value < 1 && value > 0 ? value.toFixed(2) : value.toFixed(value < 10 ? 1 : 0)}%`;
}

export function ErrorShareLine({ buckets, stepSeconds, requests, errors, thresholdPercent }: Props) {
  const n = buckets.length;
  const shares = buckets.map((_, i) => (requests[i] > 0 ? (errors[i] / requests[i]) * 100 : 0));
  let peak = 0;
  let peakIndex = 0;
  shares.forEach((value, i) => {
    if (value > peak) {
      peak = value;
      peakIndex = i;
    }
  });
  const max = Math.min(100, niceMax(Math.max(peak, thresholdPercent ?? 0, 1) * 1.1));
  const x = (i: number) => ((i + 0.5) / Math.max(1, n)) * VIEW_W;
  const y = (value: number) => VIEW_H - (Math.min(value, max) / max) * VIEW_H;
  const line = shares.map((value, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  const area = n > 0 ? `${line} L${x(n - 1).toFixed(1)} ${VIEW_H} L${x(0).toFixed(1)} ${VIEW_H} Z` : "";
  const summary =
    peak > 0
      ? `Share of 5xx responses per bucket; highest ${percentText(peak)} at ${formatBucketTime(buckets[peakIndex], stepSeconds, true)} UTC`
      : "Share of 5xx responses per bucket; no 5xx responses";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-0.5 w-2.5 bg-err5" />
          5xx rate
        </span>
        {thresholdPercent !== null && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0 w-2.5 border-t border-dashed border-soft" />
            Alert at <span className="num">{percentText(thresholdPercent)}</span>
          </span>
        )}
        <span className="ml-auto text-soft">
          Scale 0 to <span className="num">{percentText(max)}</span>
        </span>
      </div>
      <div className="relative h-14">
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
        >
          {thresholdPercent !== null && thresholdPercent <= max && (
            <path
              d={`M0 ${y(thresholdPercent).toFixed(1)} L${VIEW_W} ${y(thresholdPercent).toFixed(1)}`}
              vectorEffect="non-scaling-stroke"
              style={{ stroke: "var(--soft)", strokeWidth: 1, strokeDasharray: "4 4" }}
            />
          )}
          {n > 0 && <path d={area} style={{ fill: "var(--err5)", fillOpacity: 0.15 }} />}
          {n > 0 && <path d={line} vectorEffect="non-scaling-stroke" style={{ fill: "none", stroke: "var(--err5)", strokeWidth: 1.75 }} />}
        </svg>
      </div>
    </div>
  );
}
