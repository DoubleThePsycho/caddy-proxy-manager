// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { RadioTower } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusDot } from "@/components/ui/StatusDot";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import { LAG_WARNING_MS, formatLag, type AuditSinkSummary } from "./sink-view";

function SinkStatus({ sink }: { sink: AuditSinkSummary }) {
  const format = useFormat();
  if (!sink.enabled) return <StatusDot tone="off" label="Disabled" />;
  if (sink.consecutiveFailures > 0) {
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <StatusDot tone="bad" label={<span className="font-semibold">Failing{sink.lastError ? `: ${sink.lastError}` : ""}</span>} />
        <span className="text-muted-foreground">
          <span className="num">{sink.consecutiveFailures}</span> {sink.consecutiveFailures === 1 ? "try" : "tries"} in a row
          {sink.nextAttemptAt && (
            <>
              , next at <span className="num">{format.time(sink.nextAttemptAt)}</span>
            </>
          )}
        </span>
      </span>
    );
  }
  if (!sink.lastDeliveryAt && sink.pendingEvents === 0) return <StatusDot tone="info" label="Waiting for events" />;
  return (
    <StatusDot
      tone="ok"
      label={
        <>
          Delivering
          {sink.lastDeliveryAt && (
            <span className="text-muted-foreground">
              {" "}
              · last <span className="num">{format.dateTime(sink.lastDeliveryAt)}</span>
            </span>
          )}
        </>
      }
    />
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-xs text-soft">{label}</span>
      <span className={cn("num text-base leading-6", tone === "bad" && "text-bad")}>{value}</span>
    </span>
  );
}

/**
 * The streaming destinations under the audit log: status, the newest event
 * each one accepted, how many wait and the lag.
 */
export function StreamingStrip({ sinks, retentionDays, generatedAt }: { sinks: AuditSinkSummary[]; retentionDays: number | null; generatedAt: string }) {
  const format = useFormat();
  const kept =
    retentionDays === null ? null : retentionDays > 0 ? `Events are kept for ${format.number(retentionDays)} days.` : "Events are kept forever.";
  return (
    <section aria-labelledby="audit-streaming-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5">
        <h2 id="audit-streaming-title" className="m-0 text-base leading-6 font-semibold">
          Streaming
        </h2>
        {kept && <span className="text-[13px] text-soft">{kept}</span>}
        <Link href="/audit-log/streaming" className="ml-auto text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline">
          Manage destinations
        </Link>
      </div>
      {sinks.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState
            compact
            icon={RadioTower}
            title="No streaming destinations"
            description="Send events to a SIEM, a syslog server or a webhook."
            action={
              <Link href="/audit-log/streaming" className="text-[13px] text-brand underline-offset-4 hover:underline">
                Add a destination
              </Link>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-3">
          {sinks.map((sink) => {
            const failing = sink.enabled && sink.consecutiveFailures > 0;
            const lagMs = sink.oldestPendingAt ? Date.parse(generatedAt) - Date.parse(sink.oldestPendingAt) : 0;
            return (
              <article
                key={sink.id}
                aria-label={sink.name}
                className={cn("flex flex-col gap-2.5 rounded-xl border bg-panel px-4 py-3.5", failing ? "border-line2" : "border-line")}
              >
                <div className="flex items-start gap-2.5">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-semibold">{sink.name}</span>
                    {sink.target && <span className="num truncate text-xs text-soft">{sink.target}</span>}
                  </span>
                  <span className="whitespace-nowrap rounded-full border border-line2 px-2 text-xs leading-5 text-muted-foreground">{sink.typeLabel}</span>
                </div>
                <SinkStatus sink={sink} />
                <div className="grid grid-cols-3 gap-2 border-t border-line pt-2.5">
                  <Stat label="Up to" value={sink.lastDeliveredId > 0 ? `#${format.number(sink.lastDeliveredId)}` : "None"} />
                  <Stat label="Waiting" value={format.number(sink.pendingEvents)} />
                  <Stat
                    label="Lag"
                    value={sink.oldestPendingAt ? formatLag(sink.oldestPendingAt, generatedAt) : "None"}
                    tone={lagMs > LAG_WARNING_MS ? "bad" : undefined}
                  />
                </div>
                {failing && (
                  <Link href="/audit-log/streaming" className="self-start text-[13px] text-brand underline-offset-4 hover:underline">
                    Edit {sink.name}
                  </Link>
                )}
              </article>
            );
          })}
        </div>
      )}
      {retentionDays !== null && retentionDays > 0 && sinks.some((sink) => sink.enabled && sink.consecutiveFailures > 0) && (
        <p className="m-0 text-xs text-warn">Events waiting for a failing destination are still deleted when they pass the retention period.</p>
      )}
    </section>
  );
}
