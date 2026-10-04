// SPDX-License-Identifier: Elastic-2.0
"use client";

import { Fragment, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Download, Lock, ShieldCheck, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusDot } from "@/components/ui/StatusDot";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  PACK_SEVERITY_LABELS,
  VIRTUAL_PATCH_MODE_LABELS,
  VIRTUAL_PATCH_MODES,
  type PackSample,
  type PackSeverity,
  type VirtualPatchingSettings,
  type VirtualPatchingView,
  type VirtualPatchMode,
  type VirtualPatchView,
} from "../types";

const API_BASE = "/api/v1/waf";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `Request failed (HTTP ${response.status})`;
}

/** Calls the virtual patching REST API with the dashboard session; throws with the API's message. */
async function callApi<T>(path: string, method: string, body?: unknown, raw?: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined && raw === undefined ? undefined : { "Content-Type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

/** "3 Oct 2026" (UTC); empty for a missing date. */
function day(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "3 Oct 2026, 06:00 UTC". */
function dayTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${day(iso)}, ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

const SEVERITY_VARIANT: Record<PackSeverity, "destructive" | "warning" | "info" | "muted"> = {
  critical: "destructive",
  high: "warning",
  medium: "info",
  low: "muted",
};

const MODE_HELP: Record<VirtualPatchMode, string> = {
  off: "Not in the WAF configuration.",
  detect: "Matching requests are logged as WAF events and reach the upstream.",
  block: "Matching requests get 403 Forbidden on hosts whose WAF blocks; hosts in detection only log them.",
};

function sampleText(sample: PackSample): string {
  return [
    `${sample.method} ${sample.path}`,
    ...Object.entries(sample.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    ...(sample.body !== undefined ? ["", sample.body] : []),
  ].join("\n");
}

function eventsHref(ruleId: number): string {
  const filters = JSON.stringify([{ dim: "waf_rule", op: "is", value: String(ruleId) }]);
  return `/security?kind=waf&filters=${encodeURIComponent(filters)}#events`;
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="num m-0 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-background px-3 py-2.5 text-xs leading-[18px]">
      {children}
    </pre>
  );
}

function Detail({ patch }: { patch: VirtualPatchView }) {
  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
      <div className="flex min-w-0 flex-col gap-2.5 text-[13px]">
        {patch.summary && <p className="m-0 whitespace-pre-line">{patch.summary}</p>}
        {patch.affected.length > 0 && (
          <div className="flex flex-col gap-1">
            <h4 className="m-0 text-[13px] font-semibold text-muted-foreground">Affected</h4>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {patch.affected.map((entry, index) => (
                <li key={index}>
                  {entry.product} {entry.versions}
                  {entry.fixed && <span className="text-muted-foreground">; fixed in {entry.fixed}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {patch.references.length > 0 && (
          <div className="flex flex-col gap-1">
            <h4 className="m-0 text-[13px] font-semibold text-muted-foreground">References</h4>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {patch.references.map((url) => (
                <li key={url} className="min-w-0 truncate">
                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-brand underline-offset-4 hover:underline">
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="m-0 text-muted-foreground">
          {patch.publishedAt && <>Published {day(patch.publishedAt)}{patch.updatedAt && patch.updatedAt !== patch.publishedAt ? `, updated ${day(patch.updatedAt)}` : ""}. </>}
          {patch.firstSeenAt && <>Received {day(patch.firstSeenAt)}. </>}
          Publisher recommends {VIRTUAL_PATCH_MODE_LABELS[patch.defaultMode].toLowerCase()}.
        </p>
        {patch.inspectsBody && (
          <p className="m-0 text-muted-foreground">
            Some of its rules read request bodies, which the WAF only inspects on hosts with the Core Rule Set loaded (or with{" "}
            <span className="num">SecRequestBodyAccess On</span> in the custom rules).
          </p>
        )}
        {patch.ruleIds.length > 0 && (
          <p className="m-0">
            Rule {patch.ruleIds.map((id) => <span key={id} className="num mr-1.5">{id}</span>)}
            <Link href={eventsHref(patch.ruleIds[0])} className="text-brand underline-offset-4 hover:underline">
              Show its events
            </Link>
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">
        <h4 className="m-0 text-[13px] font-semibold text-muted-foreground">Rules as published</h4>
        <Pre>{patch.rules.join("\n")}</Pre>
        {patch.samples.positive.length > 0 && (
          <>
            <h4 className="m-0 text-[13px] font-semibold text-muted-foreground">Requests it matches</h4>
            <Pre>{patch.samples.positive.map(sampleText).join("\n\n")}</Pre>
          </>
        )}
        {patch.samples.negative.length > 0 && (
          <>
            <h4 className="m-0 text-[13px] font-semibold text-muted-foreground">Requests it lets through</h4>
            <Pre>{patch.samples.negative.map(sampleText).join("\n\n")}</Pre>
          </>
        )}
      </div>
    </div>
  );
}

export type VirtualPatchesSectionProps = {
  view: VirtualPatchingView;
  /** Holds virtual_patches:write. */
  canWrite: boolean;
  /** The edition that includes the feature, e.g. "Enterprise". */
  editionLabel: string;
  /** Some enabled host runs the WAF; without one no patch applies. */
  wafInUse: boolean;
};

/** The Virtual patches section of the WAF page: subscription, feed status and every patch with its mode. */
export function VirtualPatchesSection({ view: initialView, canWrite, editionLabel, wafInUse }: VirtualPatchesSectionProps) {
  const router = useRouter();
  const [view, setView] = useState(initialView);
  const [form, setForm] = useState<VirtualPatchingSettings>(initialView.settings);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setView(initialView);
    setForm(initialView.settings);
  }, [initialView]);

  // A link from a WAF event (#virtual-patch-<id>) opens that patch.
  useEffect(() => {
    const match = /^#virtual-patch-([a-z0-9-]+)$/.exec(window.location.hash);
    if (!match) return;
    setExpanded(match[1]);
    document.getElementById(`virtual-patch-${match[1]}`)?.scrollIntoView({ block: "center" });
  }, []);

  const writable = canWrite && view.editable;
  const configurable = writable && view.configurable;
  const dirty = form.subscribed !== view.settings.subscribed || form.feedUrl !== view.settings.feedUrl || form.autoBlockCritical !== view.settings.autoBlockCritical;
  const { installed, lastCheck } = view.feed;
  const active = view.counts.detect + view.counts.block;

  function run<T>(task: () => Promise<T>, done: (value: T) => void) {
    setError(null);
    startTransition(async () => {
      try {
        done(await task());
        router.refresh();
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : "The request failed";
        setError(message);
        toast.error(message);
        router.refresh();
      }
    });
  }

  function saveSubscription() {
    run(
      () => callApi<{ settings: VirtualPatchingSettings }>("/rule-feed", "PUT", form),
      (result) => {
        setView((previous) => ({ ...previous, settings: result.settings }));
        setForm(result.settings);
        toast.success("Subscription saved");
      }
    );
  }

  function fetchNow() {
    run(
      () => callApi<{ outcome: string; sequence: number; added: string[]; updated: string[] }>("/rule-feed/fetch", "POST"),
      (result) =>
        toast.success(
          result.outcome === "unchanged"
            ? `Feed sequence ${result.sequence} is already installed`
            : `Installed feed sequence ${result.sequence}: ${plural(result.added.length, "new patch", "new patches")}, ${result.updated.length} updated`
        )
    );
  }

  function importFile(file: File) {
    run(
      async () => callApi<{ outcome: string; sequence: number; added: string[] }>("/rule-feed/import", "POST", undefined, await file.text()),
      (result) =>
        toast.success(
          result.outcome === "unchanged"
            ? `Feed sequence ${result.sequence} is already installed`
            : `Imported feed sequence ${result.sequence}: ${plural(result.added.length, "new patch", "new patches")}`
        )
    );
  }

  function setMode(patch: VirtualPatchView, mode: VirtualPatchMode) {
    run(
      () => callApi<VirtualPatchView>(`/virtual-patches/${encodeURIComponent(patch.id)}`, "PUT", { mode }),
      (updated) => {
        setView((previous) => ({ ...previous, patches: previous.patches.map((item) => (item.id === updated.id ? updated : item)) }));
        toast.success(`${patch.cves[0] ?? patch.title}: ${VIRTUAL_PATCH_MODE_LABELS[mode].toLowerCase()}`);
      }
    );
  }

  const feedLine = installed
    ? `Feed sequence ${installed.sequence}, ${installed.source === "import" ? "imported" : "fetched"} ${dayTime(installed.installedAt)}, expires ${day(installed.expiresAt)}`
    : view.source === "master"
      ? "Patches from the master"
      : "No feed installed yet";
  const checkLine = lastCheck
    ? lastCheck.outcome === "failed"
      ? `Last ${lastCheck.source === "import" ? "import" : "fetch"} ${dayTime(lastCheck.at)} failed`
      : `Last ${lastCheck.source === "import" ? "import" : "fetch"} ${dayTime(lastCheck.at)}: ${
          lastCheck.outcome === "unchanged"
            ? "no change"
            : `${lastCheck.added} new, ${lastCheck.updated} updated, ${lastCheck.withdrawn} withdrawn`
        }`
    : view.settings.subscribed
      ? "Waiting for the first fetch"
      : null;

  return (
    <SectionCard
      id="virtual-patches"
      title="Virtual patches"
      count={view.counts.total}
      descriptionPlacement="below"
      description="WAF rules for newly published CVEs, from a signed feed. They run on every host whose WAF is on, ahead of the Core Rule Set, until you can update the affected software."
      actions={
        <>
          <Badge variant="outline">{editionLabel}</Badge>
          {configurable && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                aria-label="Feed file to import"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) importFile(file);
                }}
              />
              <Button size="sm" variant="outline" disabled={pending} onClick={() => fileInput.current?.click()}>
                <Upload aria-hidden="true" />
                Import feed file
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={fetchNow}>
                <Download aria-hidden="true" />
                Fetch now
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 px-[18px] py-3.5">
        {!view.configurable && view.editable && (
          <Banner tone="neutral" icon={Lock} title={`Virtual patching needs an active ${editionLabel} license.`}>
            Patches that are on keep protecting your hosts, and an existing subscription keeps fetching. You can still unsubscribe and turn
            patches off.{" "}
            <Link href="/license" className="text-brand underline-offset-4 hover:underline">
              Manage the license
            </Link>
          </Banner>
        )}
        {view.source === "master" && (
          <Banner tone="info" title="This node is a sync replica.">
            It applies the virtual patches its master turned on. Change them on the master.
          </Banner>
        )}
        {!wafInUse && active > 0 && (
          <Banner tone="warn" title="No host runs the WAF, so no patch applies.">
            Turn the WAF on for the hosts to protect, globally or per host in the table above.
          </Banner>
        )}
        {view.feed.expired && installed && (
          <Banner tone="warn" title={`The installed feed expired on ${day(installed.expiresAt)}.`}>
            Its patches keep applying. Fetch or import a newer feed to get patches for new CVEs.
          </Banner>
        )}
        {view.editable && view.feed.trustedKeyIds.length === 0 && (
          <Banner tone="neutral" title="This build trusts no feed signing key yet.">
            Every feed is refused until a release adds the publisher&apos;s key.
          </Banner>
        )}
        {lastCheck?.outcome === "failed" && lastCheck.error && (
          <Banner tone="bad" title={`${checkLine}.`}>
            {lastCheck.error}. Nothing was changed.
          </Banner>
        )}
        {error && error !== lastCheck?.error && (
          <Banner tone="bad" live title="The request failed.">
            {error}
          </Banner>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-muted-foreground">
          <StatusDot tone={installed && !view.feed.expired ? "ok" : view.feed.expired ? "warn" : "off"} label={feedLine} />
          {checkLine && lastCheck?.outcome !== "failed" && <span>{checkLine}</span>}
          {active > 0 && (
            <span>
              <span className="num">{view.counts.block}</span> blocking, <span className="num">{view.counts.detect}</span> detecting
            </span>
          )}
        </div>

        {view.editable && (
          <fieldset disabled={!writable || pending} className="flex flex-col gap-3 rounded-xl border border-line bg-panel2 p-3">
            <legend className="sr-only">Subscription</legend>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <label className="flex items-center gap-2.5 text-sm">
                <Switch
                  checked={form.subscribed}
                  onCheckedChange={(value) => setForm((previous) => ({ ...previous, subscribed: value }))}
                  disabled={!writable || (!view.configurable && !form.subscribed)}
                  aria-label="Fetch the feed daily"
                />
                <span>Fetch daily from</span>
              </label>
              <Input
                value={form.feedUrl}
                onChange={(event) => setForm((previous) => ({ ...previous, feedUrl: event.target.value }))}
                disabled={!configurable}
                aria-label="Feed URL"
                inputMode="url"
                spellCheck={false}
                className="num min-w-0 flex-[1_1_320px]"
              />
            </div>
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox
                checked={form.autoBlockCritical}
                onCheckedChange={(value) => setForm((previous) => ({ ...previous, autoBlockCritical: value === true }))}
                disabled={!writable || (!view.configurable && !form.autoBlockCritical)}
                className="mt-0.5"
                aria-label="Block new critical patches automatically"
              />
              <span className="flex flex-col gap-0.5">
                <span>Block new critical patches automatically</span>
                <span className="text-muted-foreground">
                  Only patches the publisher marks as safe to block. Every other new patch starts in detection, so you can check its events
                  before blocking.
                </span>
              </span>
            </label>
            {writable && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={saveSubscription} disabled={pending || !dirty}>
                  Save subscription
                </Button>
                {dirty && (
                  <Button size="sm" variant="ghost" onClick={() => setForm(view.settings)} disabled={pending}>
                    Discard
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">
                  The feed is signed; a mirror can serve the same file from another https URL.
                </span>
              </div>
            )}
          </fieldset>
        )}
      </div>

      {view.patches.length === 0 ? (
        <EmptyState
          compact
          icon={ShieldCheck}
          title="No virtual patches yet"
          description={
            view.editable
              ? "Subscribe to the feed, or import a feed file on an install without internet access. New patches start in detection."
              : "The master has no patch turned on."
          }
        />
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted-foreground">
                <th scope="col" className="w-8 py-2 pl-[18px]"><span className="sr-only">Details</span></th>
                <th scope="col" className="px-2.5 py-2 font-medium">Patch</th>
                <th scope="col" className="px-2.5 py-2 font-medium">Severity</th>
                <th scope="col" className="px-2.5 py-2 font-medium">Affected</th>
                <th scope="col" className="px-2.5 py-2 font-medium">Published</th>
                <th scope="col" className="py-2 pl-2.5 pr-[18px] font-medium">Mode</th>
              </tr>
            </thead>
            <tbody>
              {view.patches.map((patch) => {
                const open = expanded === patch.id;
                const detailId = `virtual-patch-detail-${patch.id}`;
                // Without the license a patch can only be turned off.
                const modeOptions = VIRTUAL_PATCH_MODES.map((mode) => ({
                  value: mode,
                  label: VIRTUAL_PATCH_MODE_LABELS[mode],
                  disabled: !writable || (mode !== "off" && !view.configurable),
                }));
                return (
                  <Fragment key={patch.id}>
                    <tr id={`virtual-patch-${patch.id}`} className={cn("border-b border-line align-top hover:bg-panel2", open && "bg-panel2")}>
                      <td className="py-2.5 pl-[18px]">
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={open ? detailId : undefined}
                          aria-label={`${open ? "Hide" : "Show"} details of ${patch.cves.join(", ")}`}
                          onClick={() => setExpanded(open ? null : patch.id)}
                          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:text-foreground"
                        >
                          {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                        </button>
                      </td>
                      <td className="px-2.5 py-2.5">
                        <span className="flex flex-col gap-0.5">
                          <span className="flex flex-wrap items-center gap-1.5">
                            {patch.cves.map((cve) => (
                              <span key={cve} className="num rounded bg-raise px-1.5 text-xs leading-[18px] text-muted-foreground">{cve}</span>
                            ))}
                            {patch.example && <Badge variant="muted">Example</Badge>}
                            {patch.withdrawnAt && <Badge variant="warning">Withdrawn by the publisher</Badge>}
                          </span>
                          <span>{patch.title}</span>
                        </span>
                      </td>
                      <td className="px-2.5 py-2.5">
                        <Badge variant={SEVERITY_VARIANT[patch.severity]}>{PACK_SEVERITY_LABELS[patch.severity]}</Badge>
                      </td>
                      <td className="max-w-[260px] px-2.5 py-2.5 text-muted-foreground">
                        {patch.affected[0] ? `${patch.affected[0].product} ${patch.affected[0].versions}` : ""}
                        {patch.affected.length > 1 && <span> and {plural(patch.affected.length - 1, "more")}</span>}
                      </td>
                      <td className="num whitespace-nowrap px-2.5 py-2.5 text-muted-foreground">{day(patch.publishedAt)}</td>
                      <td className="py-2.5 pl-2.5 pr-[18px]">
                        <span className="flex flex-col gap-1">
                          <SegmentedControl
                            size="sm"
                            label={`Mode of ${patch.cves.join(", ")}`}
                            value={patch.mode}
                            options={modeOptions}
                            disabled={pending || !writable}
                            onChange={(mode) => setMode(patch, mode)}
                          />
                          <span className="max-w-[260px] text-xs text-muted-foreground">{MODE_HELP[patch.mode]}</span>
                        </span>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-line bg-panel2">
                        <td colSpan={6} id={detailId} className="px-[18px] pb-[18px] pt-1">
                          <Detail patch={patch} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
