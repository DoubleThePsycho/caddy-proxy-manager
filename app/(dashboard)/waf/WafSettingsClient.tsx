"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldAlert, Info, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { bytesToMib, MAX_BODY_LIMIT_MIB, MIN_BODY_LIMIT_MIB, BYTES_PER_MIB } from "@/src/lib/caddy-waf";
import type { WafSettings } from "@/src/lib/settings";
import {
  DEFAULT_INBOUND_ANOMALY_THRESHOLD,
  DEFAULT_OUTBOUND_ANOMALY_THRESHOLD,
  MAX_ANOMALY_THRESHOLD,
  MIN_ANOMALY_THRESHOLD,
  OWASP_CRS_VERSION,
  resolveWafTuning,
  type AnomalyAction,
  type ParanoiaLevel,
} from "@/src/lib/waf-tuning";
import { saveWafSettingsAction } from "./actions";
import { WafRulesStopped } from "./WafRulesStopped";
import { WafHostsSection } from "./WafHostsSection";
import { WafExclusionsSection } from "./WafExclusionsSection";
import { WafCustomRules } from "./WafCustomRules";
import { Segmented } from "./Segmented";
import { hostModeSummary, ToneDot, type WafSettingsPageData } from "./waf-settings-shared";

export type { WafHostRow, WafExclusionRow, WafSettingsPageData } from "./waf-settings-shared";

type EngineMode = WafSettings["mode"];
type BodyAction = "" | "Reject" | "ProcessPartial";

type FormState = {
  enabled: boolean;
  mode: EngineMode;
  loadCrs: boolean;
  paranoia: ParanoiaLevel;
  logNext: boolean;
  inbound: string;
  outbound: string;
  anomalyAction: AnomalyAction;
  bodyLimit: string;
  bodyMemory: string;
  bodyAction: BodyAction;
  customRules: string;
};

const FIELD_LABELS: Record<keyof FormState, string> = {
  mode: "global mode",
  enabled: "hosts covered",
  loadCrs: "Core Rule Set",
  paranoia: "paranoia level",
  logNext: "detection logging",
  inbound: "inbound threshold",
  outbound: "outbound threshold",
  anomalyAction: "over-the-threshold action",
  bodyLimit: "largest body inspected",
  bodyMemory: "body kept in memory",
  bodyAction: "over-the-limit action",
  customRules: "custom rules",
};

function formFromSettings(settings: WafSettings | null): FormState {
  const tuning = resolveWafTuning(settings);
  return {
    // No settings yet: hosts that turn their WAF on get blocking.
    enabled: settings?.enabled ?? false,
    mode: settings?.mode === "Off" || settings?.mode === "DetectionOnly" ? settings.mode : "On",
    loadCrs: settings?.load_owasp_crs ?? true,
    paranoia: tuning.paranoiaLevel,
    logNext: tuning.detectionParanoiaLevel > tuning.paranoiaLevel,
    inbound: String(tuning.inboundThreshold),
    outbound: String(tuning.outboundThreshold),
    anomalyAction: tuning.anomalyAction,
    bodyLimit: bytesToMib(settings?.request_body_limit),
    bodyMemory: bytesToMib(settings?.request_body_in_memory_limit),
    bodyAction: settings?.request_body_limit_action ?? "",
    customRules: settings?.custom_directives ?? "",
  };
}

const MODES: { value: EngineMode; label: string; description: string; recommended?: boolean }[] = [
  { value: "Off", label: "Off", description: "Requests reach the upstreams without inspection. Nothing is logged." },
  { value: "DetectionOnly", label: "Detection only", description: "Every request is checked and matches are logged as events, but nothing is blocked." },
  {
    value: "On",
    label: "Blocking",
    description: "A request whose anomaly score reaches the inbound threshold gets 403 Forbidden. Every match is logged.",
    recommended: true,
  },
];

const LEVELS: { level: ParanoiaLevel; name: string; cost: string; tone: "ok" | "warn" | "bad"; description: string }[] = [
  { level: 1, name: "Baseline", cost: "Rare", tone: "ok", description: "Catches common attacks with rules that seldom match normal traffic." },
  {
    level: 2,
    name: "Elevated",
    cost: "Some",
    tone: "warn",
    description:
      "Adds rules for encoded and obfuscated attacks. Expect false positives on search boxes, rich-text editors and JSON APIs that accept free text; most apps need one or two exclusions.",
  },
  {
    level: 3,
    name: "Strict",
    cost: "Frequent",
    tone: "bad",
    description: "Adds limits on special characters, argument lengths and request formats. Every app needs tuning; run it in detection only for a week before blocking.",
  },
  { level: 4, name: "Paranoid", cost: "Very frequent", tone: "bad", description: "Treats almost any special character as suspicious. Only for small APIs whose inputs you fully control." },
];

const BODY_HELP: Record<BodyAction, string> = {
  "": "Uses Coraza’s default: reject with 413 Payload Too Large.",
  Reject: "Rejects bodies over the limit with 413 Payload Too Large.",
  ProcessPartial: `Inspects the first part of the body up to the limit and forwards the rest, so large uploads go through. Coraza’s hard maximum is ${MAX_BODY_LIMIT_MIB.toLocaleString("en-US")} MiB.`,
};

const fmt = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, word: string) => `${fmt(count)} ${word}${count === 1 ? "" : "s"}`;

function integerIn(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

export default function WafSettingsClient({ data }: { data: WafSettingsPageData }) {
  const router = useRouter();
  const [saved, setSaved] = useState<FormState>(() => formFromSettings(data.settings));
  const [form, setForm] = useState<FormState>(saved);
  const [savedAt, setSavedAt] = useState(data.savedAt);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const readOnly = !data.canWrite;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((previous) => ({ ...previous, [key]: value }));
  const changed = (Object.keys(FIELD_LABELS) as (keyof FormState)[]).filter((key) => String(form[key]) !== String(saved[key]));

  const inbound = integerIn(form.inbound, MIN_ANOMALY_THRESHOLD, MAX_ANOMALY_THRESHOLD);
  const outbound = integerIn(form.outbound, MIN_ANOMALY_THRESHOLD, MAX_ANOMALY_THRESHOLD);
  const bodyLimit = form.bodyLimit.trim() ? integerIn(form.bodyLimit, MIN_BODY_LIMIT_MIB, MAX_BODY_LIMIT_MIB) : undefined;
  const bodyMemory = form.bodyMemory.trim() ? integerIn(form.bodyMemory, MIN_BODY_LIMIT_MIB, MAX_BODY_LIMIT_MIB) : undefined;
  const fieldErrors = {
    inbound: inbound === null ? `A whole number from ${MIN_ANOMALY_THRESHOLD} to ${fmt(MAX_ANOMALY_THRESHOLD)}` : null,
    outbound: outbound === null ? `A whole number from ${MIN_ANOMALY_THRESHOLD} to ${fmt(MAX_ANOMALY_THRESHOLD)}` : null,
    bodyLimit: bodyLimit === null ? `A whole number of MiB from ${MIN_BODY_LIMIT_MIB} to ${fmt(MAX_BODY_LIMIT_MIB)}` : null,
    bodyMemory:
      bodyMemory === null
        ? `A whole number of MiB from ${MIN_BODY_LIMIT_MIB} to ${fmt(MAX_BODY_LIMIT_MIB)}`
        : bodyMemory !== undefined && typeof bodyLimit === "number" && bodyMemory > bodyLimit
          ? "Must not be larger than the largest body inspected"
          : null,
  };
  const invalid = Object.values(fieldErrors).some(Boolean);

  const usingWaf = data.hosts.filter((host) => host.configured && host.mode !== "off").length;
  const level = LEVELS[form.paranoia - 1];
  const detectionLevel = form.logNext && form.paranoia < 4 ? form.paranoia + 1 : form.paranoia;
  const writtenAs = [
    `tx.blocking_paranoia_level=${form.paranoia}`,
    ...(detectionLevel > form.paranoia ? [`tx.detection_paranoia_level=${detectionLevel}`] : []),
    `tx.inbound_anomaly_score_threshold=${inbound ?? "?"}`,
    `tx.outbound_anomaly_score_threshold=${outbound ?? "?"}`,
  ].join(", ");

  // The strip describes what is applied now, which a never-saved form does not.
  const savedTuning = resolveWafTuning(data.settings);
  const appliedMode = data.settings?.mode ?? "On";
  const appliedCrs = Boolean(data.settings?.load_owasp_crs);
  const { summary } = data.week;

  function discard() {
    setForm(saved);
    setError(null);
  }

  function save() {
    if (readOnly || invalid) return;
    setError(null);
    startTransition(async () => {
      const result = await saveWafSettingsAction({
        enabled: form.enabled,
        mode: form.mode,
        load_owasp_crs: form.loadCrs,
        custom_directives: form.customRules.trim(),
        paranoia_level: form.paranoia,
        detection_paranoia_level: detectionLevel > form.paranoia ? detectionLevel : undefined,
        inbound_anomaly_threshold: inbound ?? undefined,
        outbound_anomaly_threshold: outbound ?? undefined,
        anomaly_action: form.anomalyAction,
        request_body_limit: typeof bodyLimit === "number" ? bodyLimit * BYTES_PER_MIB : undefined,
        request_body_in_memory_limit: typeof bodyMemory === "number" ? bodyMemory * BYTES_PER_MIB : undefined,
        request_body_limit_action: form.bodyAction || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        toast.error("The WAF settings were not saved");
        return;
      }
      const next = { ...form, customRules: form.customRules.trim() };
      setSaved(next);
      setForm(next);
      setSavedAt(result.value.savedAt);
      toast.success(result.message ?? "Saved");
      router.refresh();
    });
  }

  const modeNote =
    form.mode === "Off"
      ? {
          tone: "bad" as const,
          title: "Nothing would be inspected.",
          text:
            summary.blocked > 0
              ? `In the last 7 days the WAF blocked ${plural(summary.blocked, "request")} on these hosts.`
              : "Requests would reach the upstreams without any check.",
        }
      : form.mode === "DetectionOnly"
        ? {
            tone: "warn" as const,
            title: "Matches would be logged, not blocked.",
            text: `${
              summary.blocked > 0 ? `The ${plural(summary.blocked, "request")} blocked in the last 7 days would have reached the upstreams. ` : ""
            }Detection only suits a trial week after raising the paranoia level; switch back afterwards.`,
          }
        : null;

  return (
    <div className="flex w-full flex-col gap-5">
      <header className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <nav aria-label="Breadcrumb" className="flex gap-1.5 text-sm text-muted-foreground">
            <span>Observe</span>
            <span aria-hidden="true">/</span>
            <Link href="/security" className="hover:text-foreground">Security events</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">WAF settings</span>
          </nav>
          <h1 className="text-2xl font-semibold tracking-tight">WAF settings</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {savedAt && <span className="text-sm text-muted-foreground">Saved {formatDateTimeUtc(new Date(savedAt).getTime())} UTC</span>}
          <Button asChild variant="outline">
            <Link href="/security?kind=waf">
              <ShieldAlert aria-hidden="true" />
              WAF events
            </Link>
          </Button>
          {!readOnly && (
            <Button onClick={save} disabled={pending || invalid || changed.length === 0}>
              Save and apply
            </Button>
          )}
        </div>
      </header>

      {readOnly && (
        <p role="note" className="rounded-lg border bg-muted/30 px-4 py-2.5 text-sm text-muted-foreground">
          You can view the WAF settings. Changing them needs the WAF write permission.
        </p>
      )}

      {changed.length > 0 && !readOnly && (
        <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-primary/5 px-4 py-2.5">
          <Info className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-sm">
            <span className="font-semibold">Not applied yet: {changed.map((key) => FIELD_LABELS[key]).join(", ")}.</span>{" "}
            <span className="text-muted-foreground">Saving rebuilds the Caddy configuration and applies it to this node.</span>
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={discard} disabled={pending}>Discard</Button>
            <Button size="sm" onClick={save} disabled={pending || invalid}>Save and apply</Button>
          </span>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border bg-card px-4 py-2.5 text-sm text-muted-foreground">
        <span className="flex items-center gap-2 text-foreground">
          <ToneDot tone={appliedMode === "On" ? "ok" : appliedMode === "DetectionOnly" ? "warn" : "bad"} />
          {hostModeSummary(data.hosts)}, using {appliedCrs ? `the OWASP Core Rule Set ${OWASP_CRS_VERSION}` : "custom rules only"}
        </span>
        <span>
          {appliedCrs ? `Paranoia level ${savedTuning.paranoiaLevel} · inbound threshold ${savedTuning.inboundThreshold}` : "Core Rule Set not loaded"}
        </span>
        {data.analyticsEnabled && (
          <span>
            Last 7 days: <span className="font-mono">{fmt(summary.total)}</span> events, <span className="font-mono">{fmt(summary.blocked)}</span> blocked,{" "}
            <span className="font-mono">{fmt(summary.uniqueClientIps)}</span> source addresses
          </span>
        )}
        <Link href="/security?kind=waf" className="ml-auto text-primary hover:underline">Open events</Link>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[2_1_560px] flex-col gap-5">
          <section aria-labelledby="waf-mode-title" className="flex flex-col gap-3.5 rounded-xl border bg-card p-5">
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-0.5">
                <h2 id="waf-mode-title" className="text-base font-semibold">Global mode</h2>
                <p className="text-sm text-muted-foreground">
                  {form.enabled
                    ? "The mode for every proxy host. A host can turn the WAF off or set its own mode in the table below."
                    : `The mode for hosts that use the WAF, ${fmt(usingWaf)} of ${fmt(data.hosts.length)} today. A host can turn it off or set its own mode in the table below.`}
                </p>
              </div>
              <label className="flex items-center gap-2.5 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(value) => set("enabled", value)}
                  disabled={readOnly}
                  aria-label={`Apply to all ${data.hosts.length} hosts`}
                />
                <span>Apply to all <span className="font-mono">{fmt(data.hosts.length)}</span> hosts</span>
              </label>
            </div>
            <div role="radiogroup" aria-label="Global mode" className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-2.5">
              {MODES.map((option) => {
                const checked = form.mode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={readOnly}
                    onClick={() => set("mode", option.value)}
                    className={cn(
                      "flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed",
                      checked ? "border-primary bg-primary/5" : "hover:border-muted-foreground/40"
                    )}
                  >
                    <span className="flex items-center gap-2 font-semibold">
                      <span
                        aria-hidden="true"
                        className={cn("grid h-4 w-4 place-items-center rounded-full border-2", checked ? "border-primary" : "border-input")}
                      >
                        <span className={cn("h-1.5 w-1.5 rounded-full", checked && "bg-primary")} />
                      </span>
                      {option.label}
                      {option.recommended && (
                        <span className="rounded-full bg-primary/10 px-1.5 text-[11px] font-semibold leading-[18px] text-primary">Recommended</span>
                      )}
                    </span>
                    <span className="text-sm text-muted-foreground">{option.description}</span>
                  </button>
                );
              })}
            </div>
            {modeNote && (
              <div
                role="status"
                data-tone={modeNote.tone}
                className={cn(
                  "flex gap-2.5 rounded-xl border p-3 text-sm",
                  modeNote.tone === "bad" ? "border-destructive/40 bg-destructive/5" : "bg-muted/40"
                )}
              >
                <TriangleAlert className={cn("mt-0.5 h-4 w-4 shrink-0", modeNote.tone === "bad" ? "text-destructive" : "text-muted-foreground")} aria-hidden="true" />
                <span>
                  <span className="font-semibold">{modeNote.title}</span> <span className="text-muted-foreground">{modeNote.text}</span>
                </span>
              </div>
            )}
          </section>

          <section aria-labelledby="waf-crs-title" className="flex flex-col gap-4 rounded-xl border bg-card p-5">
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
                <h2 id="waf-crs-title" className="text-base font-semibold">Rule set</h2>
                <p className="text-sm text-muted-foreground">
                  OWASP Core Rule Set <span className="font-mono">{OWASP_CRS_VERSION}</span>, built into the Caddy image. It covers SQL
                  injection, cross-site scripting, file inclusion, remote code execution, scanners and protocol abuse. Without it only
                  your custom rules run.
                </p>
              </div>
              <label className="flex items-center gap-2.5 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <Switch checked={form.loadCrs} onCheckedChange={(value) => set("loadCrs", value)} disabled={readOnly} aria-label="Load the Core Rule Set" />
                <span>Load the Core Rule Set</span>
              </label>
            </div>

            <fieldset disabled={readOnly || !form.loadCrs} className={cn("flex flex-col gap-4", !form.loadCrs && "opacity-50")}>
              <div className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
                  <span id="waf-pl-label" className="font-semibold">Paranoia level</span>
                  <Segmented
                    labelledBy="waf-pl-label"
                    value={String(form.paranoia)}
                    onChange={(value) => {
                      const next = Number(value) as ParanoiaLevel;
                      setForm((previous) => ({ ...previous, paranoia: next, logNext: next === 4 ? false : previous.logNext }));
                    }}
                    options={LEVELS.map((entry) => ({
                      value: String(entry.level),
                      label: (
                        <>
                          <span className="font-mono font-semibold">{entry.level}</span> {entry.name}
                        </>
                      ),
                    }))}
                  />
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-3 rounded-xl border bg-muted/30 p-3">
                  <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
                    <span className="font-semibold">Level {level.level}, {level.name.toLowerCase()}</span>
                    <span className="text-sm text-muted-foreground">{level.description}</span>
                  </div>
                  <div className="flex flex-[0_1_200px] flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">False positives</span>
                    <span className="flex gap-0.5" aria-hidden="true">
                      {[1, 2, 3, 4].map((step) => (
                        <span
                          key={step}
                          data-tone={step <= level.level ? level.tone : undefined}
                          className={cn(
                            "h-1.5 flex-1 rounded-sm",
                            step > level.level && "bg-muted",
                            step <= level.level && level.tone === "ok" && "bg-primary",
                            step <= level.level && level.tone === "warn" && "bg-muted-foreground",
                            step <= level.level && level.tone === "bad" && "bg-destructive"
                          )}
                        />
                      ))}
                    </span>
                    <span className="text-sm font-semibold">{level.cost}</span>
                  </div>
                </div>
                {form.paranoia < 4 && (
                  <label className="flex items-start gap-2.5 text-sm">
                    <Checkbox
                      checked={form.logNext}
                      onCheckedChange={(value) => set("logNext", value === true)}
                      className="mt-0.5"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span>Also log level <span className="font-mono">{form.paranoia + 1}</span> matches without blocking them</span>
                      <span className="text-muted-foreground">Shows what raising the level would catch, and what it would break, before you raise it.</span>
                    </span>
                  </label>
                )}
              </div>

              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-3.5 border-t pt-3.5">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="waf-th-in" className="font-semibold">Inbound anomaly threshold</Label>
                  <div className="relative">
                    <Input
                      id="waf-th-in"
                      inputMode="numeric"
                      value={form.inbound}
                      onChange={(event) => set("inbound", event.target.value)}
                      aria-invalid={fieldErrors.inbound ? true : undefined}
                      aria-describedby="waf-th-in-help"
                      className="pr-24 font-mono"
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                      default {DEFAULT_INBOUND_ANOMALY_THRESHOLD}
                    </span>
                  </div>
                  <span id="waf-th-in-help" className={cn("text-xs", fieldErrors.inbound ? "text-destructive" : "text-muted-foreground")}>
                    {fieldErrors.inbound ??
                      "Every match adds to the request's score: critical 5, error 4, warning 3, notice 2. At 5, one critical match is enough."}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="waf-th-out" className="font-semibold">Outbound anomaly threshold</Label>
                  <div className="relative">
                    <Input
                      id="waf-th-out"
                      inputMode="numeric"
                      value={form.outbound}
                      onChange={(event) => set("outbound", event.target.value)}
                      aria-invalid={fieldErrors.outbound ? true : undefined}
                      aria-describedby="waf-th-out-help"
                      className="pr-24 font-mono"
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                      default {DEFAULT_OUTBOUND_ANOMALY_THRESHOLD}
                    </span>
                  </div>
                  <span id="waf-th-out-help" className={cn("text-xs", fieldErrors.outbound ? "text-destructive" : "text-muted-foreground")}>
                    {fieldErrors.outbound ??
                      "Scores responses for leaks such as SQL errors, stack traces and directory listings. Lower blocks more, higher lets more through."}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span id="waf-anomaly-action" className="font-semibold">Over the threshold</span>
                  <Segmented
                    labelledBy="waf-anomaly-action"
                    value={form.anomalyAction}
                    onChange={(value) => set("anomalyAction", value as AnomalyAction)}
                    options={[
                      { value: "block", label: "Block with 403" },
                      { value: "log", label: "Log only" },
                    ]}
                  />
                  <span className="text-xs text-muted-foreground">
                    {form.anomalyAction === "log"
                      ? "Requests over the threshold are logged as events and reach the upstream. Custom rules that deny still block."
                      : "Requests over the threshold get 403 Forbidden and are logged."}
                  </span>
                </div>
              </div>
              <span className="font-mono text-xs text-muted-foreground">Written as {writtenAs}</span>
            </fieldset>
          </section>

          <section aria-labelledby="waf-body-title" className="flex flex-col gap-3.5 rounded-xl border bg-card p-5">
            <div className="flex flex-col gap-0.5">
              <h2 id="waf-body-title" className="text-base font-semibold">Request bodies</h2>
              <p className="text-sm text-muted-foreground">
                Coraza holds each request body to inspect it. With the Core Rule Set its limit is <span className="font-mono">12.5 MiB</span>,
                which is why large uploads fail with 413. Hosts can set their own limits.
              </p>
            </div>
            <fieldset disabled={readOnly} className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-3.5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="waf-body-max" className="font-semibold">Largest body inspected</Label>
                <div className="relative">
                  <Input
                    id="waf-body-max"
                    inputMode="numeric"
                    placeholder="Default, 12.5"
                    value={form.bodyLimit}
                    onChange={(event) => set("bodyLimit", event.target.value)}
                    aria-invalid={fieldErrors.bodyLimit ? true : undefined}
                    className="pr-12 font-mono"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">MiB</span>
                </div>
                {fieldErrors.bodyLimit && <span className="text-xs text-destructive">{fieldErrors.bodyLimit}</span>}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="waf-body-mem" className="font-semibold">Kept in memory</Label>
                <div className="relative">
                  <Input
                    id="waf-body-mem"
                    inputMode="numeric"
                    placeholder="Default"
                    value={form.bodyMemory}
                    onChange={(event) => set("bodyMemory", event.target.value)}
                    aria-invalid={fieldErrors.bodyMemory ? true : undefined}
                    className="pr-12 font-mono"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">MiB</span>
                </div>
                {fieldErrors.bodyMemory && <span className="text-xs text-destructive">{fieldErrors.bodyMemory}</span>}
              </div>
              <div className="flex flex-col gap-1.5">
                <span id="waf-body-action" className="font-semibold">Over the limit</span>
                <Segmented
                  labelledBy="waf-body-action"
                  value={form.bodyAction}
                  onChange={(value) => set("bodyAction", value as BodyAction)}
                  options={[
                    { value: "", label: "Default" },
                    { value: "Reject", label: "Reject" },
                    { value: "ProcessPartial", label: "Inspect the start" },
                  ]}
                />
              </div>
            </fieldset>
            <span className="text-xs text-muted-foreground">{BODY_HELP[form.bodyAction]}</span>
          </section>
        </div>

        <WafRulesStopped week={data.week} analyticsEnabled={data.analyticsEnabled} />
      </div>

      <WafHostsSection hosts={data.hosts} globalMode={saved.mode} appliesToAll={saved.enabled} canWrite={data.canWrite} />

      <WafExclusionsSection exclusions={data.exclusions} hosts={data.hosts} canWrite={data.canWrite} />

      <WafCustomRules
        value={form.customRules}
        onChange={(value) => set("customRules", value)}
        crsLoaded={form.loadCrs}
        readOnly={readOnly}
        droppedDirectives={data.droppedDirectives}
      />

      <p className="text-xs text-muted-foreground">
        {data.analyticsEnabled ? "Event counts from ClickHouse, last 7 days. Times in UTC." : "Event counts need ClickHouse analytics, which are off. Times in UTC."}
      </p>
    </div>
  );
}
