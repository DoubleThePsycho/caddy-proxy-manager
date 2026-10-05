"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Ban, MoreHorizontal, Search } from "lucide-react";
import { toast } from "sonner";
import type { AccessList, AccessListRule, BlockedSourcesPlaceholder } from "@/lib/models/access-lists";
import {
  ACCESS_LIST_RULE_KINDS,
  DEFAULT_DENY_BODY,
  DEFAULT_DENY_STATUS,
  ruleKindLabel,
  ruleValuesText,
  type AccessListRuleKind,
} from "@/lib/access-list-rules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { paginate } from "@/src/lib/pagination";
import { AccessListsHeader } from "./AccessListsHeader";
import { parseDraftValues } from "./access-list-draft";
import { matchesBlockedSearch } from "./access-list-view";
import { KIND_OPTIONS, fmtDateTime, fmtDay, fromLocalInput, toLocalInput } from "./rule-format";
import { blockSourceAction, saveBlockedSourcesAction, unblockSourceAction } from "./actions";

type Props = {
  list: AccessList | BlockedSourcesPlaceholder;
  /** Requests it stopped in the last 24 hours; null when not counted. */
  stopped: number | null;
  /** Lists of hosts, for the other tab. */
  listCount: number;
  canWrite: boolean;
  trustedProxiesConfigured: boolean;
};

const EXPIRY = [
  { value: "never", label: "Never", seconds: null },
  { value: "1h", label: "1 hour", seconds: 3600 },
  { value: "24h", label: "24 hours", seconds: 86_400 },
  { value: "7d", label: "7 days", seconds: 7 * 86_400 },
  { value: "30d", label: "30 days", seconds: 30 * 86_400 },
] as const;
type ExpiryValue = (typeof EXPIRY)[number]["value"];

/** Longest reason a rule keeps (MAX_RULE_NOTE_LENGTH). */
const MAX_REASON = 500;

function isExpired(rule: AccessListRule): boolean {
  return rule.expired || (rule.expiresAt !== null && new Date(rule.expiresAt).getTime() <= Date.now());
}

function sourceText(rule: AccessListRule): string {
  return ruleValuesText(rule.kind, rule.values);
}

/** A rule as the save payload takes it back: its id keeps it, its expiry is kept when unchanged. */
function ruleBody(rule: AccessListRule) {
  return { id: rule.id, action: rule.action, kind: rule.kind, values: rule.values, note: rule.note, expiresAt: rule.expiresAt };
}

function Expires({ rule }: { rule: AccessListRule }) {
  if (!rule.expiresAt) return <span className="text-soft">Never</span>;
  if (isExpired(rule)) return <span className="text-warn">Expired</span>;
  return <span>{fmtDateTime(rule.expiresAt)}</span>;
}

function BlockDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<AccessListRuleKind>("ip");
  const [valuesText, setValuesText] = useState("");
  const [reason, setReason] = useState("");
  const [expiry, setExpiry] = useState<ExpiryValue>("never");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind("ip");
    setValuesText("");
    setReason("");
    setExpiry("never");
    setError(null);
  }, [open]);

  const parsed = parseDraftValues(kind, valuesText);
  const submit = async () => {
    if (parsed.errors.length > 0 || parsed.values.length === 0) {
      setError(parsed.errors[0] ?? "Add at least one value");
      return;
    }
    const seconds = EXPIRY.find((option) => option.value === expiry)?.seconds ?? null;
    setPending(true);
    setError(null);
    try {
      const result = await blockSourceAction({
        kind,
        values: parsed.values,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(seconds ? { expiresInSeconds: seconds } : {}),
      });
      if (!result.ok && !result.saved) {
        setError(result.error);
        return;
      }
      if (!result.ok) toast.warning(result.error);
      else toast.success(`Blocked ${ruleValuesText(kind, parsed.values)} on every host`);
      onDone();
      onClose();
    } finally {
      setPending(false);
    }
  };

  const option = KIND_OPTIONS[kind];
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Block a source</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="block-kind">Match by</Label>
              <Select value={kind} onValueChange={(value) => setKind(value as AccessListRuleKind)}>
                <SelectTrigger id="block-kind" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCESS_LIST_RULE_KINDS.map((item) => (
                    <SelectItem key={item} value={item}>{KIND_OPTIONS[item].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="block-values">Values</Label>
              <Input
                id="block-values"
                autoFocus
                className="h-9 font-mono text-[13px]"
                value={valuesText}
                placeholder={option.placeholder}
                aria-describedby="block-values-hint"
                aria-invalid={parsed.errors.length > 0}
                onChange={(event) => setValuesText(event.target.value)}
              />
            </div>
          </div>
          <span id="block-values-hint" className={cn("-mt-2 text-xs", parsed.errors.length > 0 ? "text-destructive" : "text-muted-foreground")}>
            {parsed.errors[0] ?? option.hint}
          </span>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="block-reason">
              Reason <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input id="block-reason" maxLength={MAX_REASON} value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Unblock after</span>
            <SegmentedControl
              size="sm"
              label="Unblock after"
              value={expiry}
              onChange={setExpiry}
              options={EXPIRY.map((item) => ({ value: item.value, label: item.label }))}
              className="self-start"
            />
          </div>
          {error && (
            <p role="alert" className="m-0 text-sm text-bad">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || valuesText.trim() === ""}>
              Block
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditEntryDialog({
  rule,
  list,
  onClose,
  onDone,
}: {
  rule: AccessListRule | null;
  list: AccessList | BlockedSourcesPlaceholder;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!rule) return;
    setReason(rule.note ?? "");
    setExpiresAt(rule.expiresAt ?? "");
    setError(null);
  }, [rule]);

  const submit = async () => {
    if (!rule) return;
    setPending(true);
    setError(null);
    try {
      const rules = list.rules.map((item) =>
        item.id === rule.id ? { ...ruleBody(item), note: reason.trim() || null, expiresAt: expiresAt || null } : ruleBody(item)
      );
      const result = await saveBlockedSourcesAction({ rules, ...(list.updatedAt ? { expectedUpdatedAt: list.updatedAt } : {}) });
      if (!result.ok && !result.saved) {
        setError(result.error);
        return;
      }
      if (!result.ok) toast.warning(result.error);
      else toast.success(`Saved ${sourceText(rule)}`);
      onDone();
      onClose();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={rule !== null} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{rule ? sourceText(rule) : ""}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="blocked-reason">
              Reason <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input id="blocked-reason" maxLength={MAX_REASON} value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="blocked-expires">
              Expires <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="blocked-expires"
              type="datetime-local"
              className="h-9 text-[13px]"
              value={toLocalInput(expiresAt)}
              onChange={(event) => setExpiresAt(fromLocalInput(event.target.value))}
            />
          </div>
          {error && (
            <p role="alert" className="m-0 text-sm text-bad">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResponseDialog({
  open,
  list,
  trustedProxiesConfigured,
  onClose,
  onDone,
}: {
  open: boolean;
  list: AccessList | BlockedSourcesPlaceholder;
  trustedProxiesConfigured: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [status, setStatus] = useState("");
  const [body, setBody] = useState("");
  const [redirect, setRedirect] = useState("");
  const [failClosed, setFailClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStatus(String(list.denyStatus ?? DEFAULT_DENY_STATUS));
    setBody(list.denyBody ?? "");
    setRedirect(list.denyRedirectUrl ?? "");
    setFailClosed(list.failClosed);
    setError(null);
  }, [open, list]);

  const submit = async () => {
    const code = Number(status.trim());
    if (!redirect.trim() && (!Number.isInteger(code) || code < 400 || code > 599)) {
      setError("The status of a denied request must be from 400 to 599");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await saveBlockedSourcesAction({
        denyStatus: Number.isInteger(code) ? code : DEFAULT_DENY_STATUS,
        denyBody: body.length > 0 ? body : null,
        denyRedirectUrl: redirect.trim() || null,
        failClosed,
        ...(list.updatedAt ? { expectedUpdatedAt: list.updatedAt } : {}),
      });
      if (!result.ok && !result.saved) {
        setError(result.error);
        return;
      }
      if (!result.ok) toast.warning(result.error);
      else toast.success("Saved");
      onDone();
      onClose();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Denied requests</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="blocked-status">Status</Label>
              <Input id="blocked-status" inputMode="numeric" className="h-9 font-mono" value={status} disabled={redirect.trim() !== ""} onChange={(event) => setStatus(event.target.value)} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="blocked-body">Body</Label>
              <Input id="blocked-body" className="h-9" placeholder={DEFAULT_DENY_BODY} maxLength={4096} value={body} disabled={redirect.trim() !== ""} onChange={(event) => setBody(event.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="blocked-redirect">
              Or redirect to <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input id="blocked-redirect" className="h-9 font-mono" placeholder="https://example.com/blocked" value={redirect} onChange={(event) => setRedirect(event.target.value)} />
          </div>
          {(trustedProxiesConfigured || list.failClosed) && (
            <div className="flex items-start gap-3.5">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Label htmlFor="blocked-fail-closed">Deny when the client address is unknown</Label>
                <span className="text-xs text-muted-foreground">A trusted proxy sent no usable X-Forwarded-For. Off lets these requests through.</span>
              </span>
              <Switch id="blocked-fail-closed" checked={failClosed} onCheckedChange={setFailClosed} />
            </div>
          )}
          {error && (
            <p role="alert" className="m-0 text-sm text-bad">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The global Blocked sources list: what every host denies before anything else, with search and pages. */
export default function BlockedSourcesClient({ list, stopped, listCount, canWrite, trustedProxiesConfigured }: Props) {
  const router = useRouter();
  const pathname = usePathname() ?? "/access-lists";
  const searchParams = useSearchParams();
  const { page, hrefFor } = useUrlPage();
  const [search, setSearch] = useState(() => searchParams?.get("q") ?? "");
  const [blockOpen, setBlockOpen] = useState(false);
  const [responseOpen, setResponseOpen] = useState(false);
  const [editing, setEditing] = useState<AccessListRule | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  // Newest first: the latest blocks are the ones people come to check.
  const sorted = useMemo(
    () => [...list.rules].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id),
    [list.rules]
  );
  const filtered = useMemo(() => sorted.filter((rule) => matchesBlockedSearch(rule, search)), [sorted, search]);
  const slice = paginate(filtered, page);

  const changeSearch = (value: string) => {
    setSearch(value);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (value.trim()) params.set("q", value);
    else params.delete("q");
    params.delete("page");
    const text = params.toString();
    window.history.replaceState(null, "", text ? `${pathname}?${text}` : pathname);
  };

  const unblock = async (rule: AccessListRule) => {
    setBusy(rule.id);
    try {
      const result = await unblockSourceAction(rule.id);
      if (!result.ok && !result.saved) {
        toast.error(result.error);
        return;
      }
      if (!result.ok) toast.warning(result.error);
      else toast.success(`Unblocked ${sourceText(rule)}`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const actionsMenu = (rule: AccessListRule) =>
    canWrite && (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${sourceText(rule)}`} disabled={busy === rule.id}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(rule)}>Edit reason or expiry</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-bad focus:text-bad" onSelect={() => void unblock(rule)}>
            Unblock
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

  const blockButton = canWrite && (
    <Button type="button" onClick={() => setBlockOpen(true)}>
      <Ban /> Block a source
    </Button>
  );

  const response = list.denyRedirectUrl
    ? `Redirect to ${list.denyRedirectUrl}`
    : `${list.denyStatus ?? DEFAULT_DENY_STATUS} · ${list.denyBody || DEFAULT_DENY_BODY}`;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AccessListsHeader tab="blocked" listCount={listCount} blockedCount={list.rules.length} actions={blockButton} />

      <p className="m-0 text-[13px] text-muted-foreground">
        Denied on every host before anything else, including each host&apos;s access list.
        {stopped !== null && (
          <>
            {" "}
            <span className="num text-foreground">{stopped.toLocaleString("en-US")}</span> requests stopped in the last 24 hours.
          </>
        )}
      </p>

      {list.rules.length === 0 ? (
        <section aria-label="Blocked sources" className="rounded-2xl border border-line bg-panel">
          <EmptyState icon={Ban} title="Nothing is blocked" action={blockButton || undefined} />
        </section>
      ) : (
        <>
          <label className="flex h-[38px] min-w-0 max-w-xl items-center gap-2 rounded-[10px] border border-line bg-panel px-3 text-soft focus-within:border-brand">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="sr-only">Search blocked sources</span>
            <input
              type="search"
              value={search}
              onChange={(event) => changeSearch(event.target.value)}
              placeholder="Address, country, AS number or reason"
              className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-soft"
            />
          </label>

          <section aria-label="Blocked sources" className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel">
            {filtered.length === 0 ? (
              <EmptyState
                compact
                icon={null}
                title="No blocked source matches this search"
                action={
                  <Button variant="secondary" size="sm" onClick={() => changeSearch("")}>
                    Clear search
                  </Button>
                }
              />
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[760px] border-collapse text-[13px]">
                    <thead>
                      <tr className="text-left text-xs text-soft">
                        <th scope="col" className="border-b border-line py-2 pl-[18px] pr-2.5 font-medium">Source</th>
                        <th scope="col" className="border-b border-line px-2.5 py-2 font-medium">Reason</th>
                        <th scope="col" className="border-b border-line px-2.5 py-2 font-medium">Added</th>
                        <th scope="col" className="border-b border-line px-2.5 py-2 font-medium">Expires</th>
                        <th scope="col" className="w-12 border-b border-line py-2 pl-1.5 pr-[18px]">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {slice.items.map((rule) => (
                        <tr key={rule.id} className="border-b border-line align-top last:border-b-0 hover:bg-panel2" data-testid="blocked-source-row">
                          <td className="py-3 pl-[18px] pr-2.5">
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <span className="num [overflow-wrap:anywhere]">{sourceText(rule)}</span>
                              <span className="text-xs text-muted-foreground">{ruleKindLabel(rule.kind, rule.values)}</span>
                            </span>
                          </td>
                          <td className="px-2.5 py-3">{rule.note ?? <span className="text-soft">–</span>}</td>
                          <td className="whitespace-nowrap px-2.5 py-3 text-muted-foreground">{fmtDay(rule.createdAt)}</td>
                          <td className="whitespace-nowrap px-2.5 py-3">
                            <Expires rule={rule} />
                          </td>
                          <td className="py-2.5 pl-1.5 pr-[18px] text-right">{actionsMenu(rule)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="flex flex-col md:hidden" aria-label="Blocked sources">
                  {slice.items.map((rule) => (
                    <li key={rule.id} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0" data-testid="blocked-source-row">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="num text-[13px] [overflow-wrap:anywhere]">{sourceText(rule)}</span>
                        {rule.note && <span className="text-[13px]">{rule.note}</span>}
                        <span className="text-xs text-muted-foreground">
                          {ruleKindLabel(rule.kind, rule.values)} · Added {fmtDay(rule.createdAt)} ·{" "}
                          {rule.expiresAt ? (isExpired(rule) ? "Expired" : `Expires ${fmtDateTime(rule.expiresAt)}`) : "No expiry"}
                        </span>
                      </div>
                      <div className="shrink-0">{actionsMenu(rule)}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <Pagination
              page={slice.page}
              perPage={slice.perPage}
              total={slice.total}
              noun="sources"
              label="Pages of blocked sources"
              hrefFor={hrefFor}
              className="border-t border-line px-[18px] py-3"
            />
          </section>
        </>
      )}

      <SectionCard
        title="Denied requests"
        divided={false}
        actions={
          canWrite && (
            <Button type="button" variant="outline" size="sm" onClick={() => setResponseOpen(true)}>
              Change
            </Button>
          )
        }
      >
        <p className="m-0 px-[18px] pb-3.5 text-[13px] text-muted-foreground [overflow-wrap:anywhere]" data-testid="blocked-sources-response">
          <span className="num text-foreground">{response}</span>
          {list.failClosed && " · Denied when the client address is unknown"}
        </p>
      </SectionCard>

      <BlockDialog open={blockOpen} onClose={() => setBlockOpen(false)} onDone={() => router.refresh()} />
      <EditEntryDialog rule={editing} list={list} onClose={() => setEditing(null)} onDone={() => router.refresh()} />
      <ResponseDialog
        open={responseOpen}
        list={list}
        trustedProxiesConfigured={trustedProxiesConfigured}
        onClose={() => setResponseOpen(false)}
        onDone={() => router.refresh()}
      />
    </div>
  );
}
