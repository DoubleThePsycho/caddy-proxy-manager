// SPDX-License-Identifier: Elastic-2.0
"use client";

import { Pagination } from "@/components/ui/Pagination";
import { SectionCard } from "@/components/ui/SectionCard";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import type { VersionView } from "@/ee/config-history/versions";
import { REASON_SHORT, describeActors, groupByDay, initials, leadActor, versionDot, type DotTone } from "./history-format";

const DOT: Record<DotTone, string> = {
  live: "bg-ok",
  selected: "bg-brand",
  warn: "bg-warn",
  plain: "bg-soft",
};

export function LivePill({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ok-tint font-semibold text-ok",
        size === "sm" ? "h-5 px-[7px] text-[11px]" : "h-[22px] px-2 text-xs"
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-ok" />
      Live
    </span>
  );
}

export function ReasonPill({ reason, label, size = "sm" }: { reason: VersionView["reason"]; label: string; size?: "sm" | "md" }) {
  const warn = reason === "before_restore" || reason === "import";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full font-semibold",
        size === "sm" ? "h-5 px-[7px] text-[11px]" : "h-[22px] px-2 text-xs",
        warn ? "bg-warn-tint text-warn" : reason === "manual" ? "bg-raise text-foreground" : "bg-raise text-muted-foreground"
      )}
    >
      {label}
    </span>
  );
}

export function Avatar({ name, size = "sm" }: { name: string | null; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-raise font-semibold text-foreground",
        size === "sm" ? "h-4 w-4 text-[8px]" : "h-5 w-5 text-[9px]"
      )}
    >
      {initials(name)}
    </span>
  );
}

type Props = {
  versions: VersionView[];
  total: number;
  page: number;
  perPage: number;
  selectedId: number | null;
  onSelect: (version: VersionView) => void;
  now: number;
};

/** The versions of this page on a vertical line, grouped by day, newest first. */
export function VersionTimeline({ versions, total, page, perPage, selectedId, onSelect, now }: Props) {
  const fmt = useFormat();
  const groups = groupByDay(versions, now, fmt.timeZone);
  const pages = Math.max(1, Math.ceil(total / perPage));

  return (
    <SectionCard
      title="Versions"
      description="Newest first"
      className="flex-[1_1_340px]"
      footer={
        pages > 1 ? (
          <Pagination
            page={page}
            perPage={perPage}
            total={total}
            noun="versions"
            label="Pages of versions"
            hrefFor={(target) => (target <= 1 ? "/history" : `/history?page=${target}`)}
          />
        ) : undefined
      }
    >
      <div className="flex flex-col pb-2.5 pt-1.5">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col">
            <h3 className="m-0 px-[18px] pb-1.5 pt-2.5 text-xs font-semibold text-soft">{group.label}</h3>
            <ol className="m-0 flex list-none flex-col gap-0.5 px-2.5">
              {group.items.map((version) => {
                const on = version.id === selectedId;
                const reason = REASON_SHORT[version.reason];
                const who = describeActors(version.actors);
                return (
                  <li key={version.id} className="relative pl-[22px]">
                    <span aria-hidden="true" className="absolute bottom-0 left-[10px] top-0 w-0.5 bg-line" />
                    <span
                      aria-hidden="true"
                      className={cn("absolute left-[5px] top-[17px] h-3 w-3 rounded-full border-2 border-panel", DOT[versionDot(version, on)])}
                    />
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => onSelect(version)}
                      className={cn(
                        "flex w-full flex-col gap-1 rounded-[10px] border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        on ? "border-brand bg-brand-tint" : "border-transparent hover:bg-panel2"
                      )}
                    >
                      <span className="flex w-full items-center gap-2">
                        <span className="num text-[13px] font-semibold">#{version.id}</span>
                        {version.live && <LivePill />}
                        {reason && <ReasonPill reason={version.reason} label={reason} />}
                        <span className="num ml-auto text-xs text-soft">{fmt.time(version.createdAt)}</span>
                      </span>
                      <span className="text-[13px] font-medium leading-[19px] [overflow-wrap:anywhere]">{version.title}</span>
                      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <Avatar name={leadActor(version.actors)} />
                          {who}
                        </span>
                        <span className="num text-soft">{version.size}</span>
                        {version.changeRequestIds.length > 0 && (
                          <span>
                            Approval request <span className="num">{version.changeRequestIds.map((id) => `#${id}`).join(", ")}</span>
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
