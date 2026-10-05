"use client";

import { cn } from "@/lib/utils";
import type { DroppedWafDirectiveReport } from "@/src/lib/caddy-waf";
import type { WafSettings } from "@/src/lib/settings";
import type { WafHostView } from "@/src/lib/waf-hosts";
import type { WafExclusion } from "@/src/lib/models/waf-exclusions";
import type { TopWafRule, WafPeriodSummary } from "@/src/lib/models/waf-events";

export type WafHostRow = WafHostView & { events: { count: number; blocked: number } };
export type WafExclusionRow = WafExclusion & { ruleMessage: string | null };

export type WafSettingsPageData = {
  settings: WafSettings | null;
  savedAt: string | null;
  canWrite: boolean;
  analyticsEnabled: boolean;
  hosts: WafHostRow[];
  exclusions: WafExclusionRow[];
  week: {
    from: number;
    to: number;
    summary: WafPeriodSummary;
    daily: { day: string; count: number; blocked: number }[];
    topRules: TopWafRule[];
  };
  droppedDirectives: DroppedWafDirectiveReport[];
};

const fmt = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, word: string) => `${fmt(count)} ${word}${count === 1 ? "" : "s"}`;

export function ToneDot({ tone, className }: { tone: "ok" | "warn" | "bad"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        tone === "ok" && "bg-primary",
        tone === "warn" && "bg-muted-foreground",
        tone === "bad" && "bg-destructive",
        className
      )}
    />
  );
}

export const EFFECTIVE_MODE_LABELS: Record<WafHostView["effectiveMode"], string> = {
  block: "Blocking",
  detection_only: "Detection only",
  off: "Off",
};
export const EFFECTIVE_MODE_TONES: Record<WafHostView["effectiveMode"], "ok" | "warn" | "bad"> = {
  block: "ok",
  detection_only: "warn",
  off: "bad",
};

/** Hosts per effective mode, as "Blocking on 7 hosts, detection only on 1 host". */
export function hostModeSummary(hosts: WafHostRow[]): string {
  const blocking = hosts.filter((host) => host.effectiveMode === "block").length;
  const detecting = hosts.filter((host) => host.effectiveMode === "detection_only").length;
  const parts: string[] = [];
  if (blocking > 0) parts.push(`Blocking on ${plural(blocking, "host")}`);
  if (detecting > 0) parts.push(`${parts.length > 0 ? "detection only" : "Detection only"} on ${plural(detecting, "host")}`);
  return parts.length > 0 ? parts.join(", ") : "No host uses the WAF";
}

