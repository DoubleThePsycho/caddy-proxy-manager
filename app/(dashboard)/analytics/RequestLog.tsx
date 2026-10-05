"use client";

/** The latest requests matching the filters, newest first, with "Show more". */
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/skeleton";
import type { RequestLogEntry } from "@/src/lib/analytics";
import { cn } from "@/lib/utils";
import { OUTCOME_COLOR, OUTCOME_LOG_LABEL, formatLogTime } from "./present";

export function RequestLog({
  rows,
  loading,
  error,
  withDay,
  hasMore,
  loadingMore,
  onMore,
  mitigatedOnly,
  onMitigatedOnlyChange,
}: {
  rows: readonly RequestLogEntry[] | null;
  loading: boolean;
  error: string | null;
  /** The range spans more than a day: show the day with each time. */
  withDay: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  /** Lists only mitigated requests (outcome is not served). */
  mitigatedOnly: boolean;
  onMitigatedOnlyChange: (mitigatedOnly: boolean) => void;
}) {
  return (
    <section aria-labelledby="analytics-log-title" className="flex flex-col overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-[18px] py-3.5">
        <h2 id="analytics-log-title" className="m-0 text-base leading-6 font-semibold">
          Requests
        </h2>
        <SegmentedControl
          size="sm"
          label="Requests to list"
          className="ml-auto"
          value={mitigatedOnly ? "mitigated" : "all"}
          onChange={(value) => onMitigatedOnlyChange(value === "mitigated")}
          options={[
            { value: "all", label: "All" },
            { value: "mitigated", label: "Mitigated only" },
          ]}
        />
      </div>
      {error && !rows ? (
        <p role="alert" className="m-0 border-t border-line px-[18px] py-4 text-[13px] text-bad">
          {error}
        </p>
      ) : !rows ? (
        <div className="flex flex-col gap-2 border-t border-line px-[18px] py-4" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="m-0 border-t border-line px-[18px] py-6 text-center text-[13px] text-soft">
          {mitigatedOnly ? "No mitigated requests match the filters in this period." : "No requests match the filters in this period."}
        </p>
      ) : (
        <div className={cn("overflow-x-auto", loading && "opacity-70")} aria-busy={loading}>
          <table className="w-full min-w-[920px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs text-soft">
                <th scope="col" className="border-y border-line px-[18px] py-2 font-medium">
                  Time (UTC)
                </th>
                <th scope="col" className="border-y border-line px-2.5 py-2 font-medium">
                  Outcome
                </th>
                <th scope="col" className="border-y border-line px-2.5 py-2 font-medium">
                  Request
                </th>
                <th scope="col" className="border-y border-line px-2.5 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="border-y border-line px-2.5 py-2 font-medium">
                  Source
                </th>
                <th scope="col" className="border-y border-line py-2 pl-2.5 pr-[18px] font-medium">
                  User agent
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${row.ts}-${row.ip}-${i}`} className="border-b border-line last:border-b-0 hover:bg-panel2">
                  <td className="num whitespace-nowrap px-[18px] py-2 text-muted-foreground">{formatLogTime(row.ts, withDay)}</td>
                  <td className="whitespace-nowrap px-2.5 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: OUTCOME_COLOR[row.outcome] ?? "var(--soft)" }} />
                      {OUTCOME_LOG_LABEL[row.outcome] ?? row.outcome}
                      {row.outcome === "waf" && row.wafRuleId > 0 && <span className="num text-xs text-soft">{row.wafRuleId}</span>}
                    </span>
                  </td>
                  <td className="max-w-[460px] px-2.5 py-2">
                    <span className="block truncate" title={`${row.method} ${row.host}${row.path}`}>
                      <span className="num text-muted-foreground">{row.method}</span> <span>{row.host}</span>
                      <span className="num text-muted-foreground">{row.path}</span>
                    </span>
                  </td>
                  <td className="num px-2.5 py-2">{row.status}</td>
                  <td className="whitespace-nowrap px-2.5 py-2">
                    <span className="num">{row.ip}</span> <span className="text-soft">{row.country}</span>
                  </td>
                  <td className="max-w-[260px] truncate py-2 pl-2.5 pr-[18px] text-muted-foreground" title={row.userAgent}>
                    {row.userAgent}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > 0 && (hasMore || error) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-[18px] py-2.5">
          {hasMore && (
            <Button variant="outline" size="sm" onClick={onMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Show more"}
            </Button>
          )}
          {error && (
            <span role="alert" className="text-[13px] text-bad">
              {error}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
