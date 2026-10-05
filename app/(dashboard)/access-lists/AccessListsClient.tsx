"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, Plus, Search, ShieldCheck } from "lucide-react";
import type { AccessList, AccessListUsage } from "@/lib/models/access-lists";
import type { AccessListStats } from "@/lib/access-list-stats";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { paginate } from "@/src/lib/pagination";
import { AccessListsHeader, accessListHref } from "./AccessListsHeader";
import { DeleteAccessListDialog, NewAccessListDialog } from "./AccessListDialogs";
import { describeAccessList, matchesListSearch } from "./access-list-view";

type Props = {
  lists: AccessList[];
  /** Hosts using each list, by list id (only hosts the user can see). */
  usage: Record<number, AccessListUsage[]>;
  stats: AccessListStats;
  /** Entries of the Blocked sources list; null hides its tab (organisation users). */
  blockedCount: number | null;
  canWrite: boolean;
};

/** Host names shown in a row before "+N more". */
const HOSTS_SHOWN = 2;

function fmt(value: number): string {
  return value.toLocaleString("en-US");
}

function hostLabel(host: AccessListUsage): string {
  return host.domains[0] ?? host.name;
}

function UsedBy({ list, hosts }: { list: AccessList; hosts: AccessListUsage[] }) {
  if (hosts.length === 0) return <span className="text-soft">Not used</span>;
  const more = hosts.length - HOSTS_SHOWN;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      {hosts.slice(0, HOSTS_SHOWN).map((host, index) => (
        <span key={host.id} className="min-w-0">
          <Link
            href={`/proxy-hosts/${host.id}`}
            className={cn("num underline-offset-4 hover:underline [overflow-wrap:anywhere]", !host.enabled && "text-muted-foreground")}
          >
            {hostLabel(host)}
          </Link>
          {index < Math.min(hosts.length, HOSTS_SHOWN) - 1 && <span className="text-soft">,</span>}
        </span>
      ))}
      {more > 0 && (
        <Link href={`${accessListHref(list.id)}#used-by`} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          +{more} more
        </Link>
      )}
    </span>
  );
}

function Stopped({ list, stats }: { list: AccessList; stats: AccessListStats }) {
  const listStats = stats.lists[list.id];
  const failed = list.entries.length > 0 ? listStats?.failedSignIns ?? 0 : 0;
  return (
    <span className="flex flex-col items-end">
      <span className="num">{fmt(listStats?.stopped ?? 0)}</span>
      {failed > 0 && <span className="text-xs text-muted-foreground">{fmt(failed)} failed sign-ins</span>}
    </span>
  );
}

export default function AccessListsClient({ lists, usage, stats, blockedCount, canWrite }: Props) {
  const router = useRouter();
  const pathname = usePathname() ?? "/access-lists";
  const searchParams = useSearchParams();
  const { page, hrefFor } = useUrlPage();
  const [search, setSearch] = useState(() => searchParams?.get("q") ?? "");
  const [newOpen, setNewOpen] = useState(false);
  const [deleting, setDeleting] = useState<AccessList | null>(null);

  const sorted = useMemo(() => [...lists].sort((a, b) => a.name.localeCompare(b.name)), [lists]);
  const filtered = useMemo(
    () => sorted.filter((list) => matchesListSearch(list, usage[list.id] ?? [], search)),
    [sorted, usage, search]
  );
  const slice = paginate(filtered, page);
  const showStats = stats.available;

  // The search is kept in the address (?q=) so reload and back keep it; a new search starts at page 1.
  const changeSearch = (value: string) => {
    setSearch(value);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (value.trim()) params.set("q", value);
    else params.delete("q");
    params.delete("page");
    const text = params.toString();
    window.history.replaceState(null, "", text ? `${pathname}?${text}` : pathname);
  };

  const actionsMenu = (list: AccessList) =>
    canWrite && (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${list.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={accessListHref(list.id)}>Edit</Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-bad focus:text-bad" onSelect={() => setDeleting(list)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

  const newButton = canWrite && (
    <Button type="button" onClick={() => setNewOpen(true)}>
      <Plus /> New access list
    </Button>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AccessListsHeader tab="lists" listCount={lists.length} blockedCount={blockedCount} actions={newButton} />

      {lists.length === 0 ? (
        <section aria-label="Access lists" className="rounded-2xl border border-line bg-panel">
          <EmptyState icon={ShieldCheck} title="No access lists yet" action={newButton || undefined} />
        </section>
      ) : (
        <>
          <label className="flex h-[38px] min-w-0 max-w-xl items-center gap-2 rounded-[10px] border border-line bg-panel px-3 text-soft focus-within:border-brand">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="sr-only">Search access lists</span>
            <input
              type="search"
              value={search}
              onChange={(event) => changeSearch(event.target.value)}
              placeholder="Name, address, country, user or host"
              className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-soft"
            />
          </label>

          <section aria-label="Access lists" className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel">
            {filtered.length === 0 ? (
              <EmptyState
                compact
                icon={null}
                title="No access list matches this search"
                action={
                  <Button variant="secondary" size="sm" onClick={() => changeSearch("")}>
                    Clear search
                  </Button>
                }
              />
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[860px] border-collapse text-[13px]">
                    <thead>
                      <tr className="text-left text-xs text-soft">
                        <th scope="col" className="border-b border-line py-2 pl-[18px] pr-2.5 font-medium">Name</th>
                        <th scope="col" className="border-b border-line px-2.5 py-2 font-medium">What it does</th>
                        <th scope="col" className="border-b border-line px-2.5 py-2 font-medium">Used by</th>
                        {showStats && <th scope="col" className="border-b border-line px-2.5 py-2 whitespace-nowrap text-right font-medium">Stopped, 24 h</th>}
                        <th scope="col" className="w-12 border-b border-line py-2 pl-1.5 pr-[18px]">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {slice.items.map((list) => (
                        <tr key={list.id} className="border-b border-line align-top last:border-b-0 hover:bg-panel2" data-testid="access-list-row">
                          <td className="w-[26%] py-3 pl-[18px] pr-2.5">
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <Link href={accessListHref(list.id)} className="font-semibold text-foreground underline-offset-4 hover:underline [overflow-wrap:anywhere]">
                                {list.name}
                              </Link>
                              {list.description && <span className="line-clamp-2 text-xs text-muted-foreground">{list.description}</span>}
                            </span>
                          </td>
                          <td className="px-2.5 py-3">
                            {describeAccessList({ rules: list.rules, defaultAction: list.defaultAction, memberCount: list.entries.length })}
                          </td>
                          <td className="w-[24%] px-2.5 py-3">
                            <UsedBy list={list} hosts={usage[list.id] ?? []} />
                          </td>
                          {showStats && (
                            <td className="px-2.5 py-3 text-right">
                              <Stopped list={list} stats={stats} />
                            </td>
                          )}
                          <td className="py-2.5 pl-1.5 pr-[18px] text-right">{actionsMenu(list)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="flex flex-col md:hidden" aria-label="Access lists">
                  {slice.items.map((list) => {
                    const listStats = stats.lists[list.id];
                    return (
                      <li key={list.id} className="flex items-start gap-3 border-b border-line px-4 py-3.5 last:border-b-0" data-testid="access-list-row">
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <Link href={accessListHref(list.id)} className="font-semibold text-foreground underline-offset-4 hover:underline [overflow-wrap:anywhere]">
                            {list.name}
                          </Link>
                          <span className="text-[13px]">
                            {describeAccessList({ rules: list.rules, defaultAction: list.defaultAction, memberCount: list.entries.length })}
                          </span>
                          <span className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
                            <UsedBy list={list} hosts={usage[list.id] ?? []} />
                          </span>
                          {showStats && (listStats?.stopped ?? 0) > 0 && (
                            <span className="text-xs text-muted-foreground">
                              <span className="num text-foreground">{fmt(listStats?.stopped ?? 0)}</span> stopped in 24 h
                            </span>
                          )}
                        </div>
                        <div className="shrink-0">{actionsMenu(list)}</div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            <Pagination
              page={slice.page}
              perPage={slice.perPage}
              total={slice.total}
              noun="lists"
              label="Pages of access lists"
              hrefFor={hrefFor}
              className="border-t border-line px-[18px] py-3"
            />
          </section>
        </>
      )}

      <NewAccessListDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(list) => router.push(accessListHref(list.id))}
        onStoredOnly={() => router.refresh()}
      />
      <DeleteAccessListDialog
        list={deleting}
        hostCount={deleting ? (usage[deleting.id] ?? []).length : 0}
        onClose={() => setDeleting(null)}
        onDeleted={() => router.refresh()}
      />
    </div>
  );
}
