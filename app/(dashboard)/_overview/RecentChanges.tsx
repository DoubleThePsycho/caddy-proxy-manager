"use client";

import Link from "next/link";
import { Settings2 } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { OverviewChange } from "@/src/lib/overview-shared";
import { changeTimeLabel, initials, lowerFirst } from "./format";

/** The latest audit events, with "Roll back" where the configuration history holds the version from before. */
export function RecentChanges({ changes, now }: { changes: OverviewChange[]; now: number }) {
  const fmt = useFormat();
  return (
    <SectionCard title="Recent changes" link={{ label: "Audit log", href: "/audit-log" }}>
      {changes.length === 0 ? (
        <EmptyState compact icon={null} title="No changes recorded yet" className="px-[18px]" />
      ) : (
        <ol className="m-0 list-none py-1.5 pl-0" data-testid="recent-changes">
          {changes.map((change) => (
            <li key={change.id} className="flex gap-3 px-[18px] py-2.5">
              <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-raise text-[11px] font-semibold text-muted-foreground">
                {change.who ? initials(change.who) : <Settings2 className="h-3.5 w-3.5" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] break-words">
                  {change.who ? (
                    <>
                      <span className="font-semibold">{change.who}</span> {lowerFirst(change.summary)}
                    </>
                  ) : (
                    change.summary
                  )}
                </span>
                <span className="flex flex-wrap gap-x-2.5 text-xs text-soft">
                  <time className="num" dateTime={change.at}>
                    {changeTimeLabel(change.at, now, fmt.timeZone)}
                  </time>
                  {!change.who && <span>System</span>}
                  {change.rollbackHref && (
                    <Link
                      href={change.rollbackHref}
                      aria-label={`Roll back: ${change.summary}`}
                      className="text-brand underline-offset-4 hover:underline"
                    >
                      Roll back
                    </Link>
                  )}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}
