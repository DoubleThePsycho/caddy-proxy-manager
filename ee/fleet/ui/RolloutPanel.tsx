// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useEffect, useState } from "react";
import { Check, Clock, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { cn } from "@/lib/utils";
import type { ConfigDiff } from "@/ee/config-history/diff";
import type { RevisionDiff } from "@/ee/fleet/revisions";
import type { EnvironmentView, FleetInstanceView, RevisionView, RolloutTargetView, RolloutView } from "@/ee/fleet/types";
import { requestJson } from "./FleetDialogs";
import { PHASE_LABELS, formatDuration, formatWhen, joinNames, revisionLabel } from "./fleet-view";

type StepState = "done" | "current" | "waiting" | "failed" | "skipped";

type Step = {
  key: string;
  title: string;
  state: StepState;
  status: string;
  detail: string;
  /** The canary's observation: seconds elapsed of the total. */
  progress?: { elapsed: number; total: number };
};

const STEP_STATUS_CLASS: Record<StepState, string> = {
  done: "text-ok",
  current: "text-brand",
  waiting: "text-soft",
  failed: "text-bad",
  skipped: "text-soft",
};

const TARGET_TONE: Record<RolloutTargetView["status"], StatusTone> = {
  synced: "ok",
  failed: "bad",
  skipped: "off",
  pending: "info",
};

/** Lines of the compact "what changes" summary before it says how many more there are. */
const SUMMARY_LINES = 12;

type SummaryLine = { kind: "head" | "add" | "remove" | "note"; text: string };

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** The diff as short lines: each changed item under its type, its fields as − and + lines. */
export function summarizeConfigDiff(diff: ConfigDiff): SummaryLine[] {
  const lines: SummaryLine[] = [];
  for (const entity of diff.entities) {
    for (const item of entity.added) lines.push({ kind: "add", text: `${entity.label} · ${item.label} (added)` });
    for (const item of entity.removed) lines.push({ kind: "remove", text: `${entity.label} · ${item.label} (removed)` });
    for (const item of entity.changed) {
      lines.push({ kind: "head", text: `${entity.label} · ${item.label}` });
      for (const change of item.changes) {
        if (change.secret) {
          lines.push({ kind: "note", text: `  ${change.path}: changed (secret, not shown)` });
          continue;
        }
        lines.push({ kind: "remove", text: `${change.path}: ${formatValue(change.before)}` });
        lines.push({ kind: "add", text: `${change.path}: ${formatValue(change.after)}` });
      }
    }
  }
  return lines;
}

function StepIcon({ step, index }: { step: Step; index: number }) {
  const box = "grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full";
  if (step.state === "done") {
    return (
      <span aria-hidden="true" className={cn(box, "bg-ok-tint text-ok")}>
        <Check className="h-3.5 w-3.5" strokeWidth={2.6} />
      </span>
    );
  }
  if (step.state === "failed") {
    return (
      <span aria-hidden="true" className={cn(box, "bg-bad-tint text-bad")}>
        <X className="h-3.5 w-3.5" strokeWidth={2.6} />
      </span>
    );
  }
  if (step.state === "current") {
    return (
      <span aria-hidden="true" className={cn(box, "bg-brand-tint text-brand")}>
        <Clock className="h-3.5 w-3.5" strokeWidth={2.4} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cn(box, "num bg-raise text-xs font-semibold text-muted-foreground")}>
      {index + 1}
    </span>
  );
}

function targetText(target: RolloutTargetView, rollout: RolloutView, pull: boolean, now: number): string {
  const kind = target.role === "canary" ? "canary" : pull ? "pull replica" : "replica";
  switch (target.status) {
    case "synced":
      return `${kind} · took #${rollout.revisionId}${target.syncedAt ? ` at ${formatWhen(target.syncedAt, now)}` : ""}`;
    case "failed":
      return `${kind} · failed${target.error ? `: ${target.error}` : ""}`;
    case "skipped":
      return `${kind} · skipped${target.error ? `: ${target.error}` : ""}`;
    default:
      if (target.role === "canary" || rollout.phase === "rolling") return `${kind} · ${pull ? "takes it with its next poll" : `taking #${rollout.revisionId}`}`;
      return `${kind} · waits for the canary`;
  }
}

function buildSteps(
  rollout: RolloutView,
  environment: EnvironmentView | undefined,
  pullIds: ReadonlySet<number>,
  stepSeconds: number,
  now: number
): Step[] {
  const to = `#${rollout.revisionId}`;
  const from = revisionLabel(rollout.fromRevisionId);
  const canary = rollout.targets.find((target) => target.role === "canary") ?? null;
  const rest = rollout.targets.filter((target) => target.role === "rest");
  const order = ["canary", "observing", "rolling", "done"] as const;
  const phaseIndex = order.indexOf(rollout.phase);
  const failed = rollout.status === "failed";
  const checks = rollout.canary.checkCaddyStatus
    ? `its health endpoint, Caddy's apply status, fingerprint ${to} and no local changes`
    : "its health endpoint";

  const canaryStep: Step = (() => {
    if (!canary) return { key: "canary", title: "Canary", state: "skipped", status: "Skipped", detail: "No canary: every node takes the revision at once." };
    const pull = pullIds.has(canary.instanceId);
    if (canary.status === "synced") {
      return {
        key: "canary",
        title: "Canary",
        state: "done",
        status: `Done${canary.syncedAt ? ` · ${formatWhen(canary.syncedAt, now)}` : ""}`,
        detail: `${canary.instanceName} took ${to}.`,
      };
    }
    if (canary.status === "failed" || canary.status === "skipped") {
      return { key: "canary", title: "Canary", state: "failed", status: "Failed", detail: canary.error ?? `${canary.instanceName} did not take ${to}.` };
    }
    return {
      key: "canary",
      title: "Canary",
      state: "current",
      status: "Running",
      detail: pull
        ? `${canary.instanceName} is a pull replica: it takes ${to} with its next poll and must confirm it.`
        : `Pushing ${to} to ${canary.instanceName}.`,
    };
  })();

  const observeStep: Step = (() => {
    const title = "Observe the canary";
    if (!canary) return { key: "observe", title, state: "skipped", status: "Skipped", detail: "Nothing to observe without a canary." };
    const total = rollout.canary.waitSeconds;
    if (rollout.phase === "observing") {
      const until = rollout.canary.observeUntil ? Date.parse(rollout.canary.observeUntil) : now;
      const left = Math.max(0, Math.round((until - now) / 1000));
      return {
        key: "observe",
        title,
        state: failed ? "failed" : "current",
        status: left > 0 ? `${formatDuration(left)} left of ${formatDuration(total)}` : "Last check",
        detail: `Every ${stepSeconds} s: ${checks}. One failure stops the rollout.`,
        progress: { elapsed: Math.max(0, total - left), total },
      };
    }
    if (phaseIndex > order.indexOf("observing")) {
      return { key: "observe", title, state: "done", status: "Done", detail: `${canary.instanceName} stayed healthy for ${formatDuration(total)}.` };
    }
    return {
      key: "observe",
      title,
      state: "waiting",
      status: "Waiting",
      detail: `For ${formatDuration(total)}, every ${stepSeconds} s: ${checks}. One failure stops the rollout.`,
    };
  })();

  const rolloutStep: Step = (() => {
    const title = "Roll out to the rest";
    if (rest.length === 0) return { key: "rest", title, state: "skipped", status: "Nothing else", detail: "The canary is the only node in the environment." };
    const synced = rest.filter((target) => target.status === "synced").length;
    const names = joinNames(rest.map((target) => target.instanceName));
    const pulls = rest.filter((target) => pullIds.has(target.instanceId)).map((target) => target.instanceName);
    const pullNote = pulls.length > 0 ? ` ${joinNames(pulls)} ${pulls.length === 1 ? "is a pull replica: it takes" : "are pull replicas: they take"} ${to} with the next poll and must confirm it.` : "";
    if (rollout.phase === "rolling") {
      return {
        key: "rest",
        title,
        state: failed ? "failed" : "current",
        status: `${synced} of ${rest.length} done`,
        detail: `Up to four nodes at a time.${pullNote}`,
      };
    }
    if (phaseIndex > order.indexOf("rolling")) {
      return { key: "rest", title, state: "done", status: "Done", detail: `${names} took ${to}.` };
    }
    return { key: "rest", title, state: "waiting", status: "Waiting", detail: `${names} ${rest.length === 1 ? "takes" : "take"} ${to}, up to four nodes at a time.${pullNote}` };
  })();

  const envName = environment?.name ?? rollout.environmentName ?? "the environment";
  const pinStep: Step =
    rollout.status === "succeeded"
      ? { key: "pin", title: `Pin ${envName} to ${to}`, state: "done", status: "Done", detail: `Every node confirmed ${to}.` }
      : {
          key: "pin",
          title: `Pin ${envName} to ${to}`,
          state: "waiting",
          status: "Waiting",
          detail: `Once every node confirms. A failed push or check stops here and leaves the rest on ${from}.`,
        };

  return [canaryStep, observeStep, rolloutStep, pinStep];
}

type Props = {
  rollout: RolloutView;
  environment: EnvironmentView | undefined;
  /** Where the revision came from: an environment's name, or null for the master's configuration. */
  sourceName: string | null;
  instances: readonly FleetInstanceView[];
  revision: RevisionView | undefined;
  stepSeconds: number;
  now: number;
  canAbort: boolean;
  pending: boolean;
  onAbort: () => void;
  onShowDiff: () => void;
};

/**
 * A running rollout as its four stages (canary, observe, roll out, pin),
 * with an inline confirmation to abort it, what it changes and where each
 * target stands.
 */
export function RolloutPanel({ rollout, environment, sourceName, instances, revision, stepSeconds, now, canAbort, pending, onAbort, onShowDiff }: Props) {
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [diff, setDiff] = useState<ConfigDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const pullIds = new Set(instances.filter((instance) => instance.syncMode === "pull").map((instance) => instance.id));
  const steps = buildSteps(rollout, environment, pullIds, stepSeconds, now);
  const headingId = `rollout-${rollout.id}-title`;
  const envName = environment?.name ?? rollout.environmentName ?? "a deleted environment";
  const against = rollout.fromRevisionId === null ? "previous" : String(rollout.fromRevisionId);

  useEffect(() => {
    let cancelled = false;
    requestJson<RevisionDiff>(`/api/v1/fleet/revisions/${rollout.revisionId}/diff?against=${encodeURIComponent(against)}`)
      .then((result) => {
        if (!cancelled) setDiff(result.diff);
      })
      .catch((error: Error) => {
        if (!cancelled) setDiffError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [rollout.revisionId, against]);

  const synced = rollout.targets.filter((target) => target.status === "synced").map((target) => target.instanceName);
  const notReached = rollout.targets.filter((target) => target.status === "pending").map((target) => target.instanceName);
  const lines = diff ? summarizeConfigDiff(diff) : [];
  const source = rollout.kind === "rollback" ? `rolls back to what ${envName} ran before` : sourceName ? `source: what ${sourceName} runs` : "source: the master's configuration";

  return (
    <section id={`rollout-${rollout.id}`} aria-labelledby={headingId} className="scroll-mt-6 overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 px-5 pt-4 pb-3">
        <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <h2 id={headingId} className="m-0 text-base leading-6 font-semibold">
              {rollout.kind === "rollback" ? "Rollback" : "Rollout"} <span className="num">#{rollout.id}</span>: revision{" "}
              <span className="num">#{rollout.revisionId}</span> to {envName}
            </h2>
            <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-brand-tint px-2.5 text-xs font-semibold text-brand">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
              {PHASE_LABELS[rollout.phase]}
            </span>
          </div>
          <p className="m-0 text-[13px] text-soft">
            Started <span className="num">{formatWhen(rollout.createdAt, now)}</span>
            {rollout.startedByName ? ` by ${rollout.startedByName}` : ""} · replaces <span className="num">{revisionLabel(rollout.fromRevisionId)}</span> ·{" "}
            {source}
          </p>
        </div>
        {canAbort && (
          <Button variant="danger" size="sm" aria-expanded={confirmAbort} disabled={pending} onClick={() => setConfirmAbort(true)}>
            <Square className="h-3.5 w-3.5" /> Abort rollout
          </Button>
        )}
      </div>

      {canAbort && confirmAbort && (
        <div
          role="alertdialog"
          aria-labelledby={`${headingId}-abort`}
          className="mx-5 mb-3 flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-[10px] border border-line2 bg-bad-tint px-3.5 py-3"
        >
          <p id={`${headingId}-abort`} className="m-0 min-w-0 flex-[1_1_360px] text-[13px]">
            <span className="font-semibold">Abort rollout #{rollout.id}?</span>{" "}
            <span className="text-muted-foreground">
              Nothing else is pushed.
              {synced.length > 0 ? ` ${joinNames(synced)} ${synced.length === 1 ? "keeps" : "keep"} #${rollout.revisionId}.` : ""}
              {notReached.length > 0
                ? ` ${joinNames(notReached)} and the environment stay on ${revisionLabel(rollout.fromRevisionId)}.`
                : ` The environment stays on ${revisionLabel(rollout.fromRevisionId)}.`}
            </span>
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmAbort(false)}>
              Keep running
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() => {
                setConfirmAbort(false);
                onAbort();
              }}
            >
              Abort
            </Button>
          </div>
        </div>
      )}

      <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-2.5 px-5 pb-4">
        {steps.map((step, index) => (
          <li
            key={step.key}
            aria-current={step.state === "current" ? "step" : undefined}
            className={cn(
              "flex min-w-0 flex-col gap-2 rounded-xl border px-3.5 py-3",
              step.state === "current" ? "border-brand bg-brand-tint" : "border-line bg-panel2",
              step.state === "failed" && "border-bad bg-bad-tint"
            )}
          >
            <span className="flex items-center gap-2.5">
              <StepIcon step={step} index={index} />
              <span className="min-w-0 flex-1 font-semibold">{step.title}</span>
            </span>
            <span className={cn("num text-xs font-semibold", STEP_STATUS_CLASS[step.state])}>{step.status}</span>
            {step.progress && step.progress.total > 0 && (
              <span
                role="progressbar"
                aria-label="Canary observation"
                aria-valuemin={0}
                aria-valuemax={step.progress.total}
                aria-valuenow={step.progress.elapsed}
                aria-valuetext={step.status}
                className="block h-1.5 overflow-hidden rounded-full bg-raise"
              >
                <span
                  className="block h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${Math.min(100, (step.progress.elapsed / step.progress.total) * 100)}%` }}
                />
              </span>
            )}
            <span className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{step.detail}</span>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-x-6 gap-y-4 border-t border-line px-5 pt-3.5 pb-4">
        <div className="flex min-w-0 flex-[2_1_420px] flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            <h3 className="m-0 text-sm font-semibold">What changes from {revisionLabel(rollout.fromRevisionId)}</h3>
            {revision && <span className="num text-xs text-soft">fingerprint {revision.fingerprint.slice(0, 12)}</span>}
            <Button variant="link" size="sm" className="ml-auto h-auto px-0" onClick={onShowDiff}>
              Full diff
            </Button>
          </div>
          {diffError ? (
            <p className="m-0 text-[13px] text-bad">{diffError}</p>
          ) : !diff ? (
            <p className="m-0 text-[13px] text-soft">Comparing…</p>
          ) : lines.length === 0 ? (
            <p className="m-0 text-[13px] text-muted-foreground">The configuration does not change.</p>
          ) : (
            <div className="num overflow-x-auto rounded-lg border border-line bg-background px-3 py-2.5 text-xs leading-[19px]">
              <ul className="m-0 list-none p-0">
                {lines.slice(0, SUMMARY_LINES).map((line, index) => (
                  <li
                    key={index}
                    className={cn(
                      "whitespace-pre-wrap [overflow-wrap:anywhere]",
                      line.kind === "add" && "text-ok",
                      line.kind === "remove" && "text-bad",
                      (line.kind === "head" || line.kind === "note") && "text-muted-foreground"
                    )}
                  >
                    {line.kind === "add" && (
                      <>
                        <span aria-hidden="true">+ </span>
                        <span className="sr-only">Added: </span>
                      </>
                    )}
                    {line.kind === "remove" && (
                      <>
                        <span aria-hidden="true">- </span>
                        <span className="sr-only">Removed: </span>
                      </>
                    )}
                    {line.text}
                  </li>
                ))}
              </ul>
              {lines.length > SUMMARY_LINES && (
                <p className="m-0 pt-1 font-sans text-soft">
                  {lines.length - SUMMARY_LINES} more {lines.length - SUMMARY_LINES === 1 ? "line" : "lines"} in the full diff.
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-2 text-[13px] text-muted-foreground">
          <h3 className="m-0 text-sm font-semibold text-foreground">Targets</h3>
          {rollout.targets.length === 0 ? (
            <p className="m-0">No nodes in the environment.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {rollout.targets.map((target) => (
                <li key={target.instanceId} className="flex items-start gap-2">
                  <StatusDot tone={TARGET_TONE[target.status]} className="mt-1.5" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="num text-foreground">{target.instanceName}</span>{" "}
                    {targetText(target, rollout, pullIds.has(target.instanceId), now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-xs text-soft">This dashboard is the master and already runs its own configuration; rollouts only reach replicas.</p>
        </div>
      </div>
    </section>
  );
}
