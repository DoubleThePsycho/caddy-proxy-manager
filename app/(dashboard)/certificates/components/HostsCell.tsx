"use client";

import Link from "next/link";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { hostCountText } from "../format";

export type HostLink = {
  key: string;
  name: string;
  href: string;
  /** Shown after the name in the list, e.g. "L4". */
  note?: string;
};

/**
 * "1 host" as a link to it, or "3 hosts" opening the list, with a summary
 * line underneath: the "Used by" and "Trusted by" columns.
 */
export function HostsCell({ hosts, summary, emptyText }: { hosts: readonly HostLink[]; summary?: string; emptyText: string }) {
  if (hosts.length === 0) return <span className="text-soft">{emptyText}</span>;
  return (
    <span className="flex min-w-0 flex-col">
      {hosts.length === 1 ? (
        <Link href={hosts[0].href} className="w-fit text-brand underline-offset-4 hover:text-foreground hover:underline">
          {hostCountText(1)}
        </Link>
      ) : (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="w-fit text-left text-brand underline-offset-4 hover:text-foreground hover:underline"
              aria-label={`${hostCountText(hosts.length)}, show the list`}
            >
              {hostCountText(hosts.length)}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2">
            <ul className="m-0 flex max-h-72 list-none flex-col overflow-y-auto p-0">
              {hosts.map((host) => (
                <li key={host.key}>
                  <Link
                    href={host.href}
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-[13px] text-foreground hover:bg-raise"
                  >
                    <span className="truncate">{host.name}</span>
                    {host.note && <span className="shrink-0 text-xs text-soft">{host.note}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
      {summary && <span className="truncate text-xs text-soft">{summary}</span>}
    </span>
  );
}
