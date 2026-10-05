"use client";

import type { L4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { cn } from "@/lib/utils";
import { l4DetailGroups } from "./list";

type Props = {
  /** The host to show; null closes the sheet. */
  host: L4ProxyHost | null;
  status: { tone: StatusTone; label: string } | null;
  canWrite: boolean;
  onClose: () => void;
  onToggle: (host: L4ProxyHost) => void;
  onDuplicate: (host: L4ProxyHost) => void;
  onEdit: (host: L4ProxyHost) => void;
};

/** An L4 host's settings, grouped, in a sheet over the list. */
export function L4HostDetailSheet({ host, status, canWrite, onClose, onToggle, onDuplicate, onEdit }: Props) {
  return (
    <Sheet open={host !== null} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-[560px]">
        {host && (
          <>
            <SheetHeader className="space-y-0 border-b border-line px-5 pb-4 pt-5 pr-14 text-left">
              <SheetTitle className="text-lg leading-7 [overflow-wrap:anywhere]">{host.name}</SheetTitle>
              <SheetDescription asChild>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1">
                  <span className="num rounded-md bg-raise px-2 text-xs leading-5 text-muted-foreground">
                    {host.listenAddress}/{host.protocol}
                  </span>
                  {status && <StatusDot tone={status.tone} label={status.label} />}
                </div>
              </SheetDescription>
              {canWrite && (
                <div className="flex flex-wrap gap-2 pt-3">
                  <Button size="sm" onClick={() => onEdit(host)}>
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => onToggle(host)}>
                    {host.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => onDuplicate(host)}>
                    Duplicate
                  </Button>
                </div>
              )}
            </SheetHeader>
            <div className="flex flex-col">
              {l4DetailGroups(host).map((group) => (
                <section key={group.title} className="flex min-w-0 flex-col gap-2.5 border-b border-line px-5 py-4 last:border-b-0">
                  <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">{group.title}</h3>
                  <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-x-4 gap-y-2.5">
                    {group.items.map((item) => (
                      <div key={item.label} className="flex min-w-0 flex-col gap-px">
                        <dt className="text-xs text-soft">{item.label}</dt>
                        <dd className={cn("m-0 text-[13px] break-words", item.mono && "num")}>{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
