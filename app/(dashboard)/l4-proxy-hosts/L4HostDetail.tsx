"use client";

import { useId } from "react";
import type { L4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import { Button } from "@/components/ui/button";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { cn } from "@/lib/utils";
import { l4DetailGroups } from "./list";

type Props = {
  host: L4ProxyHost;
  status: { tone: StatusTone; label: string };
  canWrite: boolean;
  onToggle: () => void;
  onDuplicate: () => void;
  onEdit: () => void;
};

/** The selected L4 host's settings, grouped as on the design's detail panel. */
export function L4HostDetail({ host, status, canWrite, onToggle, onDuplicate, onEdit }: Props) {
  const headingId = useId();
  const groups = l4DetailGroups(host);
  return (
    <section aria-labelledby={headingId} className="min-w-0 overflow-hidden rounded-2xl border border-line2 bg-panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-line px-5 py-4">
        <div className="flex min-w-0 flex-[1_1_360px] flex-wrap items-center gap-x-3 gap-y-2">
          <h2 id={headingId} className="m-0 text-base leading-6 font-semibold">
            {host.name}
          </h2>
          <span className="num rounded-md bg-raise px-2 text-xs leading-5 text-muted-foreground">
            {host.listenAddress}/{host.protocol}
          </span>
          <StatusDot tone={status.tone} label={status.label} />
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onToggle}>
              {host.enabled ? "Disable" : "Enable"}
            </Button>
            <Button variant="outline" size="sm" onClick={onDuplicate}>
              Duplicate
            </Button>
            <Button size="sm" onClick={onEdit}>
              Edit
            </Button>
          </div>
        )}
      </div>
      <div className="-mb-px -mr-px grid grid-cols-[repeat(auto-fit,minmax(min(250px,100%),1fr))]">
        {groups.map((group) => (
          <div key={group.title} className="flex min-w-0 flex-col gap-2.5 border-b border-r border-line px-5 py-4">
            <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">{group.title}</h3>
            <dl className="m-0 flex flex-col gap-2">
              {group.items.map((item) => (
                <div key={item.label} className="flex flex-col gap-px">
                  <dt className="text-xs text-soft">{item.label}</dt>
                  <dd className={cn("m-0 text-[13px] break-words", item.mono && "num")}>{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
