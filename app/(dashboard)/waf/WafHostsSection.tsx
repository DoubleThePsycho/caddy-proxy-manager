"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WafSettings } from "@/src/lib/settings";
import type { WafHostMode } from "@/src/lib/waf-host-mode";
import { setWafHostModeAction } from "./actions";
import { Segmented } from "./Segmented";
import { EFFECTIVE_MODE_LABELS, EFFECTIVE_MODE_TONES, hostModeSummary, ToneDot, type WafHostRow } from "./waf-settings-shared";

type Filter = "all" | WafHostRow["effectiveMode"];

const SETTINGS_LABELS: Record<WafHostRow["settings"], string> = {
  follows: "Follows global",
  merges: "Merges with global",
  overrides: "Overrides global",
  off: "Turned off",
};

const GLOBAL_MODE_LABELS: Record<WafSettings["mode"], string> = { On: "Blocking", DetectionOnly: "Detection only", Off: "Off" };
/** Hosts listed before "Show all": those with WAF settings of their own or events. */
const COLLAPSED_LIMIT = 12;
const fmt = (value: number) => value.toLocaleString("en-US");

/** The per-host table: each host's settings, mode and events, with the mode editable in place. */
export function WafHostsSection({
  hosts,
  globalMode,
  appliesToAll,
  canWrite,
}: {
  hosts: WafHostRow[];
  globalMode: WafSettings["mode"];
  appliesToAll: boolean;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [showAll, setShowAll] = useState(false);
  const [pending, startTransition] = useTransition();

  const counts = {
    block: hosts.filter((host) => host.effectiveMode === "block").length,
    detection_only: hosts.filter((host) => host.effectiveMode === "detection_only").length,
    off: hosts.filter((host) => host.effectiveMode === "off").length,
  };
  const filtered = hosts.filter((host) => filter === "all" || host.effectiveMode === filter);
  const isNotable = (host: WafHostRow) => host.configured || host.events.count > 0 || host.exclusions > 0;
  const notableCount = filtered.filter(isNotable).length;
  // Collapsed: every host with settings of its own, events or exclusions, topped up to COLLAPSED_LIMIT in list order.
  let room = Math.max(0, COLLAPSED_LIMIT - notableCount);
  const listed =
    showAll || filtered.length <= COLLAPSED_LIMIT
      ? filtered
      : filtered.filter((host) => isNotable(host) || (room > 0 && room-- > 0));
  const hidden = filtered.length - listed.length;
  const unused = hosts.filter((host) => !host.configured && host.effectiveMode === "off").length;

  function changeMode(host: WafHostRow, mode: WafHostMode) {
    startTransition(async () => {
      const result = await setWafHostModeAction(host.id, mode);
      if (result.ok) {
        toast.success(`WAF on ${host.name}: ${EFFECTIVE_MODE_LABELS[result.value.effectiveMode].toLowerCase()}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <section aria-labelledby="waf-hosts-title" className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3.5">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
          <h2 id="waf-hosts-title" className="text-base font-semibold">Per-host settings</h2>
          <span className="text-sm text-muted-foreground">
            {hostModeSummary(hosts)}.
            {!appliesToAll && unused > 0 && ` ${fmt(unused)} ${unused === 1 ? "host does" : "hosts do"} not use the WAF.`}
          </span>
        </div>
        <Segmented
          label="Show hosts"
          value={filter}
          onChange={(value) => setFilter(value as Filter)}
          options={[
            { value: "all", label: "All", count: hosts.length },
            { value: "block", label: "Blocking", count: counts.block },
            { value: "detection_only", label: "Detection only", count: counts.detection_only },
            { value: "off", label: "Off", count: counts.off },
          ]}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[940px] border-collapse text-sm">
          <thead>
            <tr className="border-y text-left text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium">Host</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Settings</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Mode</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Differences from global</th>
              <th scope="col" className="whitespace-nowrap px-2.5 py-2 text-right font-medium">Events, 7 days</th>
              <th scope="col" className="py-2 pl-2.5 pr-4"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {listed.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">No hosts in this view.</td>
              </tr>
            )}
            {listed.map((host) => (
              <tr key={host.id} className="border-b last:border-b-0 hover:bg-muted/30">
                <td className="px-4 py-2.5">
                  <span className="font-semibold">{host.name}</span>
                  {host.domains.length > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {host.domains[0]}
                      {host.domains.length > 1 && ` + ${host.domains.length - 1} more`}
                    </span>
                  )}
                </td>
                <td className={host.settings === "follows" ? "px-2.5 py-2.5 text-muted-foreground" : "px-2.5 py-2.5"}>
                  {SETTINGS_LABELS[host.settings]}
                </td>
                <td className="whitespace-nowrap px-2.5 py-2.5">
                  {canWrite ? (
                    <Select value={host.mode} onValueChange={(value) => changeMode(host, value as WafHostMode)} disabled={pending}>
                      <SelectTrigger className="h-8 w-[220px]" aria-label={`WAF mode of ${host.name}`}>
                        <span className="flex items-center gap-2">
                          <ToneDot tone={EFFECTIVE_MODE_TONES[host.effectiveMode]} />
                          <SelectValue />
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">Global mode ({GLOBAL_MODE_LABELS[globalMode].toLowerCase()})</SelectItem>
                        <SelectItem value="block">Blocking</SelectItem>
                        <SelectItem value="detection_only">Detection only</SelectItem>
                        <SelectItem value="off">Off</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <ToneDot tone={EFFECTIVE_MODE_TONES[host.effectiveMode]} />
                      {EFFECTIVE_MODE_LABELS[host.effectiveMode]}
                    </span>
                  )}
                </td>
                <td className={host.differences.length === 0 ? "px-2.5 py-2.5 text-muted-foreground" : "px-2.5 py-2.5"}>
                  {host.differences.length === 0
                    ? "None"
                    : host.differences.join(" · ").replace(/^./, (first) => first.toUpperCase())}
                </td>
                <td className="px-2.5 py-2.5 text-right">
                  {host.effectiveMode === "off" && host.events.count === 0 ? (
                    <span className="text-muted-foreground">Not inspected</span>
                  ) : (
                    <span className="inline-flex flex-col items-end">
                      <span className="font-mono">{fmt(host.events.count)}</span>
                      {host.events.count > 0 && host.events.blocked < host.events.count && (
                        <span className="text-xs text-muted-foreground">
                          {host.events.blocked === 0 ? "logged, not blocked" : `${fmt(host.events.blocked)} blocked`}
                        </span>
                      )}
                    </span>
                  )}
                </td>
                <td className="py-2.5 pl-2.5 pr-4 text-right">
                  <Link
                    href={`/proxy-hosts/${host.id}/edit#waf`}
                    aria-label={`Edit WAF settings for ${host.name}`}
                    className="text-sm text-primary hover:underline"
                  >
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-3 text-sm text-muted-foreground">
          <span>
            {fmt(hidden)} more {hidden === 1 ? "host" : "hosts"}
            {appliesToAll ? " follow the global settings and had no WAF events in 7 days." : " do not use the WAF or had no events in 7 days."}
          </span>
          <Button variant="link" className="ml-auto h-auto p-0" onClick={() => setShowAll(true)}>
            Show all {fmt(filtered.length)} hosts
          </Button>
        </div>
      )}
    </section>
  );
}
