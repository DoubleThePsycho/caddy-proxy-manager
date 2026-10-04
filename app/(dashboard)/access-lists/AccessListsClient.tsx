"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import type { AccessList, AccessListUsage, BlockedSourcesPlaceholder } from "@/lib/models/access-lists";
import type { AccessListStats } from "@/lib/access-list-stats";
import { classifyAccessList, countryName } from "@/lib/access-list-rules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { AccessListEditor } from "./AccessListEditor";
import { createAccessListAction } from "./actions";

type Props = {
  lists: AccessList[];
  usage: Record<number, AccessListUsage[]>;
  /** Null for organisation users. */
  blockedSources: AccessList | BlockedSourcesPlaceholder | null;
  stats: AccessListStats;
  canWrite: boolean;
  trustedProxiesConfigured: boolean;
};

const BLOCKED = "blocked" as const;
type Selection = number | typeof BLOCKED | null;

function fmt(value: number): string {
  return value.toLocaleString("en-US");
}

function TypePill({ label, basicAuth }: { label: string; basicAuth: boolean }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs">
      <span className={cn("h-1.5 w-1.5 rounded-full", basicAuth ? "bg-primary" : "bg-access")} aria-hidden="true" />
      {label}
    </span>
  );
}

function StoppedBar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 90)) : 0;
  return (
    <span className="h-1.5 w-[90px] overflow-hidden rounded-[3px] bg-muted" aria-hidden="true">
      <span className="block h-full bg-access" style={{ width: `${width}px` }} />
    </span>
  );
}

function NewListDialog({
  open,
  onClose,
  onCreated,
  onStoredOnly,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (list: AccessList) => void;
  /** Created, but Caddy did not take the configuration. */
  onStoredOnly: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultAction, setDefaultAction] = useState<"allow" | "deny">("allow");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setDefaultAction("allow");
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const result = await createAccessListAction({ name: name.trim(), description: description.trim() || null, defaultAction });
      if (!result.ok) {
        toast.error(result.error);
        if (result.saved) {
          onStoredOnly();
          onClose();
        }
        return;
      }
      toast.success(`Created ${result.value.name}`);
      onCreated(result.value);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New access list</DialogTitle>
          <DialogDescription>
            Add rules and members after creating it, then attach it to hosts from their settings.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-access-list-name">Name</Label>
            <Input id="new-access-list-name" autoFocus value={name} maxLength={200} placeholder="Office and VPN" onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-access-list-description">Description</Label>
            <Input id="new-access-list-description" value={description} maxLength={1000} placeholder="Optional" onChange={(event) => setDescription(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-access-list-unmatched">When no rule matches</Label>
            <Select value={defaultAction} onValueChange={(value) => setDefaultAction(value === "deny" ? "deny" : "allow")}>
              <SelectTrigger id="new-access-list-unmatched">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">Let the request through (a blocklist, or basic auth only)</SelectItem>
                <SelectItem value="deny">Deny the request (an allowlist)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || submitting}>{submitting ? "Creating" : "Create list"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StoppedSummary({ stats, listCount }: { stats: AccessListStats; listCount: number }) {
  const share = stats.requests && stats.requests > 0 ? `${((stats.stopped / stats.requests) * 100).toFixed(1)}%` : null;
  return (
    <section aria-label="Stopped in the last 24 hours" className="flex flex-wrap items-center gap-x-7 gap-y-2.5 rounded-xl border bg-card px-[18px] py-3.5">
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <span className="h-2 w-2 rounded-sm bg-access" aria-hidden="true" />
          Stopped by access lists, last 24 hours
        </span>
        {stats.available ? (
          <span className="flex flex-wrap items-baseline gap-x-2.5">
            <span className="font-mono text-[26px] font-medium leading-8 tracking-tight tabular-nums" data-testid="access-lists-stopped">
              {fmt(stats.stopped)}
            </span>
            <span className="text-xs text-muted-foreground">
              {share && stats.requests !== null ? (
                <>
                  <span className="font-mono">{share}</span> of <span className="font-mono">{fmt(stats.requests)}</span> requests ·{" "}
                </>
              ) : null}
              <span className="font-mono">{fmt(stats.previous)}</span> the 24 hours before
            </span>
          </span>
        ) : (
          <span className="text-sm">Analytics is off, so stopped requests are not counted.</span>
        )}
      </span>
      {stats.available && (
        <span className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-muted-foreground">
          {stats.byOutcome && (
            <>
              <span className="flex flex-col">
                <span className="text-xs">Geo rules</span>
                <span className="font-mono text-base text-foreground">{fmt(stats.byOutcome.geo)}</span>
              </span>
              <span className="flex flex-col">
                <span className="text-xs">Address rules</span>
                <span className="font-mono text-base text-foreground">{fmt(stats.byOutcome.access)}</span>
              </span>
            </>
          )}
          <span className="flex flex-col">
            <span className="text-xs">Failed sign-ins</span>
            <span className="font-mono text-base text-foreground">{fmt(stats.failedSignIns)}</span>
          </span>
          {listCount === 0 && <span className="self-end text-xs">No list is in use yet.</span>}
        </span>
      )}
      <Link href="/security" className="ml-auto text-[13px] text-primary hover:underline">See them in Security events</Link>
    </section>
  );
}

function StoppedBreakdown({ stats, listCount }: { stats: AccessListStats; listCount: number }) {
  const maxCountry = Math.max(1, ...stats.countries.map((row) => row.count));
  const maxHost = Math.max(1, ...stats.hosts.map((row) => row.count));
  return (
    <section aria-labelledby="access-lists-stopped-title" className="flex min-w-0 flex-[1_1_320px] flex-col gap-3.5 rounded-[14px] border bg-card px-5 pb-[18px] pt-4">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <h2 id="access-lists-stopped-title" className="text-base font-semibold">What was stopped, last 24 hours</h2>
        <span className="text-[13px] text-muted-foreground">
          {listCount === 1 ? "The one list" : `All ${listCount} lists together`}
        </span>
      </div>
      {!stats.available ? (
        <p className="text-sm text-muted-foreground">Analytics is not configured or could not be reached, so nothing is counted here.</p>
      ) : stats.countries.length === 0 && stats.hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing was stopped in the last 24 hours.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-x-7 gap-y-[18px]">
          <div className="flex flex-col gap-0.5">
            <h3 className="mb-1.5 text-[13px] font-semibold text-muted-foreground">From</h3>
            <ol className="flex flex-col gap-0.5">
              {stats.countries.map((row) => (
                <li key={row.code || "unknown"} className="relative flex h-[30px] items-center gap-2 overflow-hidden rounded-lg px-2">
                  <span className="absolute bottom-1 left-0 top-1 rounded-md bg-access/25" style={{ width: `${((row.count / maxCountry) * 100).toFixed(1)}%` }} aria-hidden="true" />
                  <span className={cn("relative w-[26px] flex-none rounded text-center font-mono text-[11px] font-semibold leading-[18px] text-muted-foreground", row.code && "bg-muted")}>
                    {row.code}
                  </span>
                  <span className="relative flex-1 text-[13px]">{row.code ? countryName(row.code) ?? row.code : "Unknown"}</span>
                  <span className="relative font-mono text-[13px]">{fmt(row.count)}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="flex flex-col gap-0.5">
            <h3 className="mb-1.5 text-[13px] font-semibold text-muted-foreground">To</h3>
            <ol className="flex flex-col gap-0.5">
              {stats.hosts.map((row) => (
                <li key={row.host || "unknown"} className="relative flex h-[30px] items-center gap-2 overflow-hidden rounded-lg px-2">
                  <span className="absolute bottom-1 left-0 top-1 rounded-md bg-access/25" style={{ width: `${((row.count / maxHost) * 100).toFixed(1)}%` }} aria-hidden="true" />
                  <span className="relative min-w-0 flex-1 truncate font-mono text-[13px]">{row.host || "Unknown host"}</span>
                  <span className="relative font-mono text-[13px]">{fmt(row.count)}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}

export default function AccessListsClient({
  lists: serverLists,
  usage,
  blockedSources: serverBlockedSources,
  stats,
  canWrite,
  trustedProxiesConfigured,
}: Props) {
  const router = useRouter();
  const [newOpen, setNewOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Lists saved or created here, shown until the refreshed server props catch up.
  const [local, setLocal] = useState<Record<string, AccessList>>({});
  const newer = useCallback(
    <T extends AccessList | BlockedSourcesPlaceholder>(key: string, list: T): T | AccessList => {
      const mine = local[key];
      return mine && (!list.updatedAt || mine.updatedAt > list.updatedAt) ? mine : list;
    },
    [local]
  );
  const lists = useMemo(() => {
    const merged = serverLists.map((list) => newer(String(list.id), list) as AccessList);
    for (const [key, list] of Object.entries(local)) {
      if (key !== BLOCKED && !serverLists.some((item) => String(item.id) === key)) merged.push(list);
    }
    return merged.sort((a, b) => a.name.localeCompare(b.name));
  }, [serverLists, local, newer]);
  const blockedSources = serverBlockedSources ? newer(BLOCKED, serverBlockedSources) : null;
  const [selected, setSelected] = useState<Selection>(() => serverLists[0]?.id ?? (serverBlockedSources ? BLOCKED : null));
  const removed = useRef(new Set<number>());

  // A list deleted elsewhere falls back to the first one.
  useEffect(() => {
    if (selected === BLOCKED ? !blockedSources : selected !== null && !lists.some((list) => list.id === selected)) {
      setSelected(lists[0]?.id ?? (blockedSources ? BLOCKED : null));
    }
  }, [lists, blockedSources, selected]);

  const visibleLists = lists.filter((list) => !removed.current.has(list.id));
  const selectedList = selected === BLOCKED ? blockedSources : visibleLists.find((list) => list.id === selected) ?? null;
  const rows = useMemo(() => {
    const items: Array<{ key: Selection; list: AccessList | BlockedSourcesPlaceholder }> = [];
    if (blockedSources) items.push({ key: BLOCKED, list: blockedSources });
    for (const list of lists) if (!removed.current.has(list.id)) items.push({ key: list.id, list });
    return items;
  }, [lists, blockedSources]);
  const remember = (key: string, list: AccessList) => setLocal((current) => ({ ...current, [key]: list }));
  const maxStopped = Math.max(
    1,
    ...lists.map((list) => stats.lists[list.id]?.stopped ?? 0),
    stats.blockedSources?.stopped ?? 0
  );

  const select = (key: Selection) => {
    if (key === selected) return;
    if (dirty && !window.confirm("Discard the unsaved changes to this list?")) return;
    setDirty(false);
    setSelected(key);
  };

  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);

  return (
    <div className="flex flex-col gap-[18px]">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1">
          <nav aria-label="Breadcrumb" className="flex gap-1.5 text-[13px] text-muted-foreground">
            <span>Traffic</span>
            <span aria-hidden="true">/</span>
            <span>Access lists</span>
          </nav>
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold leading-8 tracking-tight">
            Access lists
            <span className="rounded-full bg-muted px-2 font-mono text-[13px] font-semibold leading-[22px] text-muted-foreground">
              {visibleLists.length}
            </span>
          </h1>
          <span className="text-[13px] text-muted-foreground">
            Rules you attach to hosts: where visitors may come from, which addresses may connect, and who has to sign in first.
          </span>
        </div>
        {canWrite && (
          <Button type="button" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" /> New access list
          </Button>
        )}
      </header>

      <StoppedSummary stats={stats} listCount={visibleLists.length} />

      <section aria-label="Access lists" className="overflow-hidden rounded-[14px] border bg-card">
        <div className="relative overflow-x-auto">
          <Table className="min-w-[820px] text-[13px]">
            <TableHeader>
              <TableRow className="text-xs hover:bg-transparent">
                <TableHead className="pl-[18px] font-medium">List</TableHead>
                <TableHead className="font-medium">Type</TableHead>
                <TableHead className="text-right font-medium">Rules</TableHead>
                <TableHead className="font-medium">Used by</TableHead>
                <TableHead className="pr-[18px] font-medium">Stopped, 24 h</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No access lists yet. Create one to limit where visitors may come from, or who has to sign in.
                  </TableCell>
                </TableRow>
              )}
              {rows.map(({ key, list }) => {
                const system = list.system !== null;
                const type = classifyAccessList({ systemKey: list.system, defaultAction: list.defaultAction, rules: list.rules, memberCount: list.entries.length });
                const hosts = system ? [] : usage[list.id as number] ?? [];
                const listStats = system ? null : stats.lists[list.id as number];
                const stopped = system ? stats.blockedSources?.stopped ?? null : listStats?.stopped ?? 0;
                const active = key === selected;
                const authOnly = type.type === "basic_auth";
                return (
                  <TableRow key={String(key)} className={cn(active && "bg-primary/10 hover:bg-primary/10")} data-testid="access-list-row">
                    <TableCell className="py-3 pl-[18px]">
                      <span className="flex flex-col gap-0.5">
                        <button
                          type="button"
                          className="text-left font-semibold hover:text-primary"
                          aria-pressed={active}
                          onClick={() => select(key)}
                        >
                          {list.name}
                        </button>
                        {list.description && <span className="text-xs text-muted-foreground">{list.description}</span>}
                      </span>
                    </TableCell>
                    <TableCell className="py-3">
                      <TypePill label={type.label} basicAuth={authOnly} />
                    </TableCell>
                    <TableCell className="py-3 text-right font-mono">
                      {authOnly ? (
                        <>
                          {list.entries.length} <span className="font-sans text-muted-foreground">{list.entries.length === 1 ? "user" : "users"}</span>
                        </>
                      ) : (
                        list.rules.length
                      )}
                    </TableCell>
                    <TableCell className="py-3">
                      {system ? (
                        <span className="flex flex-col">
                          <span>Every host</span>
                          <span className="text-xs text-muted-foreground">Global, checked before host lists</span>
                        </span>
                      ) : hosts.length === 0 ? (
                        <span className="text-muted-foreground">Not used</span>
                      ) : (
                        <span className="flex flex-col">
                          <span>{hosts.length === 1 ? "1 host" : `${hosts.length} hosts`}</span>
                          <span className="max-w-[260px] truncate font-mono text-xs text-muted-foreground">
                            {hosts.slice(0, 3).map((host) => host.domains[0] ?? host.name).join(", ")}
                            {hosts.length > 3 ? ", ..." : ""}
                          </span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 pr-[18px]">
                      {!stats.available || stopped === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : authOnly ? (
                        <span className="flex items-center gap-2.5">
                          <StoppedBar value={listStats?.failedSignIns ?? 0} max={maxStopped} />
                          <span className="font-mono">{fmt(listStats?.failedSignIns ?? 0)}</span>
                          <span className="text-xs text-muted-foreground">failed sign-ins</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-2.5">
                          <StoppedBar value={stopped} max={maxStopped} />
                          <span className="font-mono">{fmt(stopped)}</span>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      <div className="flex flex-wrap items-start gap-5">
        {selectedList ? (
          <AccessListEditor
            key={`${selected}-${selectedList.updatedAt ?? "new"}`}
            list={selectedList}
            usage={selectedList.system ? [] : usage[selectedList.id as number] ?? []}
            listStats={selectedList.system ? null : stats.lists[selectedList.id as number] ?? null}
            blockedSourcesStopped={stats.blockedSources?.stopped ?? null}
            statsAvailable={stats.available}
            canWrite={canWrite}
            trustedProxiesConfigured={trustedProxiesConfigured}
            onDirtyChange={onDirtyChange}
            onSaved={(list) => {
              setDirty(false);
              if (list) remember(selected === BLOCKED ? BLOCKED : String(list.id), list);
              router.refresh();
            }}
            onDeleted={() => {
              setDirty(false);
              if (typeof selected === "number") {
                removed.current.add(selected);
                setLocal((current) => {
                  const next = { ...current };
                  delete next[String(selected)];
                  return next;
                });
              }
              setSelected(visibleLists.find((list) => list.id !== selected)?.id ?? (blockedSources ? BLOCKED : null));
              router.refresh();
            }}
          />
        ) : (
          <div className="flex min-w-0 flex-[2_1_560px] items-center justify-center rounded-[14px] border border-dashed px-6 py-14 text-center text-sm text-muted-foreground">
            {canWrite ? "Create an access list to edit it here." : "There are no access lists to show."}
          </div>
        )}
        <StoppedBreakdown stats={stats} listCount={visibleLists.length + (blockedSources ? 1 : 0)} />
      </div>

      <NewListDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(list) => {
          setDirty(false);
          remember(String(list.id), list);
          setSelected(list.id);
          router.refresh();
        }}
        onStoredOnly={() => router.refresh()}
      />
    </div>
  );
}
