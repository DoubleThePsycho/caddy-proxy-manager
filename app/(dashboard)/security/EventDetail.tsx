"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatCount } from "@/components/ui/chart-format";
import type { SecurityEvent } from "@/src/lib/analytics/security";
import type { WafEventExplanation, WafExclusionSuggestionView } from "@/src/lib/waf-event-explain";
import { ruleIdError } from "@/src/lib/waf-exclusions";
import { explainWafEventAction } from "../waf/actions";
import type { WafExclusionDraft } from "../waf/WafExclusionDialog";
import { wafAuditRecordAction } from "./actions";
import type { BlockTarget } from "./BlockSourceDialog";
import { analyticsHref, curlCommand, eventActionLabel, eventExplanation, type CurlRequest, type SecurityQuery } from "./security-view";

export type EventDetailContext = {
  query: SecurityQuery;
  rangeLabel: string;
  canWriteWaf: boolean;
  canReadAnalytics: boolean;
  canReadSettings: boolean;
  blockDisabledReason: string | null;
  /** Addresses the Blocked sources list already blocks. */
  blockedIps: ReadonlySet<string>;
  /** WAF events of a rule over the range, for the rules on the top list. */
  ruleEvents: ReadonlyMap<number, number>;
  /** The proxy host serving each WAF event's host name, when one does. */
  eventHostIds: Readonly<Record<string, number>>;
  onBlock: (target: BlockTarget) => void;
  onAddExclusion: (draft: WafExclusionDraft) => void;
};

/** A choice in "What you can do": a title and what it does. */
function Choice({ title, detail, onClick, disabled }: { title: ReactNode; detail: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-start gap-0.5 rounded-[10px] border border-line2 bg-panel2 px-3 py-2.5 text-left transition-colors hover:bg-raise disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-panel2"
    >
      <span className="font-semibold">{title}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">{children}</h3>;
}

function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "num m-0 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-background px-3 py-2.5 text-xs leading-[18px]",
        className
      )}
    >
      {children}
    </pre>
  );
}

function suggestionDraft(suggestion: WafExclusionSuggestionView): WafExclusionDraft {
  return {
    ruleId: String(suggestion.ruleId),
    scope: suggestion.proxyHostId === null ? "global" : String(suggestion.proxyHostId),
    path: suggestion.path ?? "",
    pathMatch: suggestion.pathMatch === "exact" ? "exact" : "prefix",
    variable: suggestion.variable ?? "",
    reason: suggestion.reason,
  };
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy as curl, the raw audit record and the analytics link, under the choices. */
function ToolLinks({ curl, event, context }: { curl: CurlRequest; event: SecurityEvent; context: EventDetailContext }) {
  const [shownCurl, setShownCurl] = useState<string | null>(null);
  const [raw, setRaw] = useState<{ status: "idle" | "loading" } | { status: "ready"; text: string } | { status: "error"; error: string }>({ status: "idle" });

  async function copy() {
    const command = curlCommand(curl);
    if (await copyText(command)) toast.success("Copied as curl.");
    else setShownCurl(command);
  }

  async function toggleRaw() {
    if (raw.status === "ready" || raw.status === "error") {
      setRaw({ status: "idle" });
      return;
    }
    if (!event.eventId) return;
    setRaw({ status: "loading" });
    const result = await wafAuditRecordAction(event.eventId);
    setRaw(result.ok ? { status: "ready", text: result.value } : { status: "error", error: result.error });
  }

  const linkClass = "text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 pt-0.5">
        <button type="button" className={linkClass} onClick={copy}>
          Copy as curl
        </button>
        {event.kind === "waf" && event.eventId && (
          <button type="button" className={linkClass} aria-expanded={raw.status === "ready" || raw.status === "error"} onClick={toggleRaw}>
            {raw.status === "loading" ? "Reading the record…" : "Raw audit record"}
          </button>
        )}
        {context.canReadAnalytics && (
          <Link className={linkClass} href={analyticsHref(context.query, [{ dim: "ip", op: "is", value: event.ip }])}>
            Open in analytics
          </Link>
        )}
      </div>
      {shownCurl && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">The clipboard is not available here; copy the command yourself.</span>
          <Pre>{shownCurl}</Pre>
        </div>
      )}
      {raw.status === "error" && <p className="m-0 text-xs text-muted-foreground">{raw.error}</p>}
      {raw.status === "ready" && <Pre className="max-h-80">{raw.text}</Pre>}
    </div>
  );
}

function BlockChoice({ event, context }: { event: SecurityEvent; context: EventDetailContext }) {
  const blocked = context.blockedIps.has(event.ip);
  const reason = blocked ? "Already on the Blocked sources list." : context.blockDisabledReason;
  return (
    <Choice
      title={`Block ${event.ip}`}
      detail={reason ?? 'Adds it to the "Blocked sources" access list on every host.'}
      disabled={reason !== null}
      onClick={() =>
        context.onBlock({
          ip: event.ip,
          country: event.country,
          note:
            event.kind === "waf" && event.ruleId !== null
              ? `From Security events: WAF rule ${event.ruleId} on ${event.host}`
              : `From Security events: ${eventActionLabel(event).toLowerCase()} on ${event.host}`,
        })
      }
    />
  );
}

type LoadState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; explanation: WafEventExplanation };

/** "Why it was blocked" for a WAF event: the explain API's score breakdown, matched data and the deciding rule. */
function WafEventDetail({ event, context, onClose }: { event: SecurityEvent; context: EventDetailContext; onClose: () => void }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    if (!event.eventId) {
      setState({ status: "error", error: "This event has no transaction id, so its audit record cannot be read." });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    explainWafEventAction(event.eventId).then(
      (result) => {
        if (cancelled) return;
        setState(result.ok ? { status: "ready", explanation: result.value } : { status: "error", error: result.error });
      },
      () => {
        if (!cancelled) setState({ status: "error", error: "Could not read this event's audit record." });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [event.eventId]);

  const explanation = state.status === "ready" ? state.explanation : null;
  const blocked = explanation ? explanation.blocked : event.blocked;
  const scored = explanation ? explanation.rules.filter((rule) => rule.kind === "attack" || rule.kind === "custom") : [];
  const showScore = explanation ? explanation.rules.some((rule) => rule.kind === "inbound_evaluation") || explanation.inboundScore > 0 : false;

  // The narrowest exclusions the explain API suggests. When the record cannot be read: the event's rule on its host and path.
  const fallback: WafExclusionDraft | null =
    state.status === "error" && event.ruleId !== null && ruleIdError(event.ruleId) === null
      ? {
          ruleId: String(event.ruleId),
          // Host names are request data: only an own entry of the map counts (never "constructor" and the like).
          scope: Object.hasOwn(context.eventHostIds, event.host) ? String(context.eventHostIds[event.host]) : "global",
          path: event.path,
          pathMatch: "exact",
          variable: "",
          reason: event.eventId ? `Suggested from WAF event ${event.eventId}` : "Suggested from a WAF event",
        }
      : null;
  const suggestions = explanation?.suggestions ?? [];
  const open = suggestions.filter((suggestion) => suggestion.existingExclusionId === null);
  const allExcluded = suggestions.length > 0 && open.length === 0;

  let falsePositiveDetail: string;
  if (!context.canWriteWaf) falsePositiveDetail = "Adding an exclusion needs the waf:write permission.";
  else if (state.status === "loading") falsePositiveDetail = "The suggested exclusion comes from the audit record.";
  else if (allExcluded) falsePositiveDetail = "The suggested exclusions already exist.";
  else if (open.length === 1) falsePositiveDetail = open[0].description;
  else if (open.length > 1) falsePositiveDetail = `Exclude the ${open.length} rules that added to the score, each as narrowly as the record allows.`;
  else if (explanation)
    falsePositiveDetail =
      explanation.decidingRule?.kind === "custom"
        ? "A custom rule decided this; change that rule in the WAF settings instead."
        : "No Core Rule Set rule added to the score, so an exclusion would change nothing.";
  else if (fallback) falsePositiveDetail = `Skip rule ${fallback.ruleId} for ${event.path || "this path"} on this host. Review it before adding.`;
  else falsePositiveDetail = "The record names no rule to exclude.";
  const canExclude = context.canWriteWaf && !allExcluded && (open.length > 0 || fallback !== null);

  function falsePositive() {
    if (open.length > 1) {
      setListOpen((value) => !value);
      return;
    }
    const draft = open.length === 1 ? suggestionDraft(open[0]) : fallback;
    if (draft) context.onAddExclusion(draft);
  }

  const request = explanation?.request;
  const matched = [
    `${request?.method ?? event.method} ${request?.uri ?? event.path}${request?.httpVersion ? ` ${request.httpVersion}` : ""}`,
    `Host: ${request?.host ?? event.host}`,
    ...(scored.some((rule) => rule.matchedData) ? ["", ...scored.filter((rule) => rule.matchedData).map((rule) => `${rule.ruleId}: ${rule.matchedData}`)] : []),
  ].join("\n");
  const ruleEvents = event.ruleId !== null ? context.ruleEvents.get(event.ruleId) : undefined;

  return (
    <div className="grid gap-4 rounded-xl border border-line2 bg-panel p-4 [grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr))]">
      <div className="flex min-w-0 flex-col gap-2.5">
        <Heading>{blocked ? "Why it was blocked" : "Why it was logged"}</Heading>
        {state.status === "loading" && (
          <p role="status" className="m-0 text-[13px] text-muted-foreground">
            Reading the audit record…
          </p>
        )}
        {state.status === "error" && (
          <p role="status" className="m-0 text-[13px] text-muted-foreground">
            {state.error}{" "}
            {event.ruleId !== null && (
              <>
                The event names rule <span className="num">{event.ruleId}</span>
                {event.message ? `: ${event.message}` : "."}
              </>
            )}
          </p>
        )}
        {explanation && (
          <>
            {showScore && (
              <div className="flex items-baseline gap-2.5">
                <span className="num text-[26px] leading-8 text-waf-ink">{explanation.inboundScore}</span>
                <span className="text-[13px] text-muted-foreground">
                  anomaly score, the limit is <span className="num">{explanation.inboundThreshold}</span>
                  {explanation.thresholdSource === "settings" ? " (current settings)" : ""}
                </span>
              </div>
            )}
            {(scored.length > 0 || explanation.decidingRule) && (
              <ol className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
                {scored.map((rule, index) => (
                  <li key={`${rule.ruleId}-${index}`} className="flex gap-2.5">
                    <span className={cn("num w-[52px] flex-none", rule.countedInScore && rule.anomalyPoints ? "text-waf-ink" : "text-muted-foreground")}>
                      {rule.anomalyPoints !== null ? (rule.countedInScore ? `+${rule.anomalyPoints}` : "0") : rule.disruptive ? "deny" : "·"}
                    </span>
                    <span className="min-w-0">
                      <span className="num text-muted-foreground">{rule.ruleId}</span> {rule.message ?? "No message"}
                      {!rule.countedInScore && rule.anomalyPoints !== null && (
                        <span className="text-muted-foreground"> (paranoia level {rule.paranoiaLevel}: logged only)</span>
                      )}
                      {rule.matchedVariable && (
                        <span className="block text-xs text-muted-foreground">
                          in <span className="num">{rule.matchedVariable}</span>
                        </span>
                      )}
                    </span>
                  </li>
                ))}
                {explanation.decidingRule && explanation.decidingRule.kind !== "attack" && explanation.decidingRule.kind !== "custom" && (
                  <li className="flex gap-2.5">
                    <span className="num w-[52px] flex-none text-muted-foreground">=</span>
                    <span className="min-w-0">
                      <span className="num text-muted-foreground">{explanation.decidingRule.ruleId}</span>{" "}
                      {explanation.decidingRule.blocked ? "Inbound anomaly score reached: blocked with 403" : explanation.decidingRule.message ?? "Logged only"}
                    </span>
                  </li>
                )}
              </ol>
            )}
            <p className="m-0 text-[13px] text-muted-foreground">{explanation.summary}</p>
          </>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2.5">
        <Heading>Matched data</Heading>
        <Pre>{matched}</Pre>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <Heading>What you can do</Heading>
        {blocked && (
          <Choice
            title="Nothing: this is working as intended"
            detail={
              ruleEvents
                ? `Rule ${event.ruleId} matched ${formatCount(ruleEvents)} times in the ${context.rangeLabel}; this request never reached the upstream.`
                : "The request never reached the upstream."
            }
            onClick={onClose}
          />
        )}
        <Choice title="This was a false positive" detail={falsePositiveDetail} disabled={!canExclude || state.status === "loading"} onClick={falsePositive} />
        {listOpen && open.length > 1 && (
          <ul className="m-0 flex list-none flex-col gap-2 rounded-[10px] border border-line px-3 py-2.5 text-[13px]">
            {open.map((suggestion, index) => (
              <li key={`${suggestion.ruleId}-${index}`} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 flex-1">{suggestion.description}</span>
                <button
                  type="button"
                  className="text-brand underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => context.onAddExclusion(suggestionDraft(suggestion))}
                >
                  Review and add
                </button>
              </li>
            ))}
          </ul>
        )}
        <BlockChoice event={event} context={context} />
        <ToolLinks
          event={event}
          context={context}
          curl={{
            method: request?.method ?? event.method,
            host: event.host,
            uri: request?.uri ?? event.path,
            headers: request?.headers ?? null,
          }}
        />
      </div>
    </div>
  );
}

const SETTINGS_LINKS: Partial<Record<SecurityEvent["kind"], { label: string; href: string; needs: "settings" | "none" }>> = {
  geo: { label: "Geoblocking settings", href: "/settings?section=geoblock", needs: "settings" },
  access: { label: "Access lists", href: "/access-lists", needs: "none" },
  rate_limit: { label: "Rate limit settings", href: "/settings?section=rate-limit", needs: "settings" },
};

/** A request stopped by a geo, access, sign-in or rate limit rule: the rule from its outcome. */
function RuleEventDetail({ event, context }: { event: SecurityEvent; context: EventDetailContext }) {
  const link = SETTINGS_LINKS[event.kind];
  const lines = [
    `${event.method} ${event.path}`,
    `Host: ${event.host}`,
    `From: ${event.ip}${event.country ? ` (${event.country})` : ""}`,
    ...(event.status > 0 ? [`Answered: ${event.status}`] : []),
  ].join("\n");
  return (
    <div className="grid gap-4 rounded-xl border border-line2 bg-panel p-4 [grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr))]">
      <div className="flex min-w-0 flex-col gap-2.5">
        <Heading>Why it was stopped</Heading>
        <p className="m-0 text-[13px] font-semibold">{eventActionLabel(event)}</p>
        <p className="m-0 text-[13px] text-muted-foreground">{eventExplanation(event)}</p>
        {link && (link.needs === "none" || context.canReadSettings) && (
          <Link href={link.href} className="text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline">
            {link.label}
          </Link>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">
        <Heading>Request</Heading>
        <Pre>{lines}</Pre>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Heading>What you can do</Heading>
        <BlockChoice event={event} context={context} />
        <ToolLinks event={event} context={context} curl={{ method: event.method, host: event.host, uri: event.path }} />
      </div>
    </div>
  );
}

/** The expanded row of an event: why it was stopped and what to do about it. */
export function EventDetail({ event, context, onClose }: { event: SecurityEvent; context: EventDetailContext; onClose: () => void }) {
  if (event.kind === "waf") return <WafEventDetail event={event} context={context} onClose={onClose} />;
  return <RuleEventDetail event={event} context={context} />;
}
