// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Building2, Download, Filter, Info, MoreHorizontal, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SearchField } from "@/components/ui/SearchField";
import { StatusDot } from "@/components/ui/StatusDot";
import { ProtectionPill } from "@/components/ui/ProtectionPill";
import { EmptyState } from "@/components/ui/EmptyState";
import { Banner } from "@/components/ui/Banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatBytes, formatCount } from "@/components/ui/chart-format";
import { cn } from "@/lib/utils";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import type { OrganizationView } from "@/ee/multi-tenancy/service";
import type { OrganizationDetail, OrganizationListItem, OrganizationMemberItem, OrganizationsPageData } from "@/ee/multi-tenancy/page-data";
import { MOVABLE_KINDS, type MovableRows } from "@/ee/multi-tenancy/types";
import {
  OrganizationDeleteDialog,
  OrganizationEditDialog,
  OrganizationMoveDialog,
  PROVIDER,
  draftBody,
  draftOf,
  type Draft,
} from "./OrganizationDialogs";

type Allowed = { proxyHosts: boolean; users: boolean; createUsers: boolean };

type Props = {
  data: OrganizationsPageData;
  movable: MovableRows;
  /** The license allows creating organisations, changing them and moving rows into them. */
  configurable: boolean;
  editionLabel: string;
  /** organizations:write */
  canWrite: boolean;
  /** What else the viewer's role holds: links to proxy hosts and users. */
  allowed?: Allowed;
  /** The organisation view the dashboard shows ("all", "provider" or an id). */
  view?: string;
  /** Stores the organisation view (a server action); it grants nothing. */
  onSetView?: (value: string) => Promise<void>;
  /** The server's time, so dates read the same on the server and in the browser. */
  now: string;
};

type Message = { ok: boolean; text: string };
type ShowFilter = "all" | "near" | "disabled";

/** A share of a limit at or above this counts as near the limit. */
const NEAR_LIMIT = 0.8;

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `Request failed (HTTP ${response.status})`;
}

async function send(url: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.status === 204 ? null : response.json();
}

/** "28 Sep" (UTC), with the year when it is not `now`'s. */
function shortDate(iso: string, now: Date): string {
  const date = new Date(iso);
  const year = date.getUTCFullYear() === now.getUTCFullYear() ? "" : ` ${date.getUTCFullYear()}`;
  return `${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]}${year}`;
}

/** "12 June 2026" (UTC). */
function longDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS_LONG[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "today 08:47 UTC" or "28 Sep". */
function when(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (date.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return `today ${date.toISOString().slice(11, 16)} UTC`;
  return shortDate(iso, now);
}

/** The billing month's short name ("Sep") from "2026-09". */
function shortMonth(month: string): string {
  return MONTHS_SHORT[Number(month.slice(5)) - 1] ?? month;
}

type LimitState = {
  used: number;
  max: number | null;
  /** used / max, capped at 1; 0 without a limit. */
  ratio: number;
  near: boolean;
  reached: boolean;
};

function limitState(used: number, max: number | null): LimitState {
  if (max === null) return { used, max, ratio: 0, near: false, reached: false };
  const ratio = max === 0 ? 1 : Math.min(1, used / max);
  return { used, max, ratio, near: ratio >= NEAR_LIMIT, reached: used >= max };
}

/** At 80% or more of either limit (a limit of 0 counts as reached). */
export function isNearLimit(organization: Pick<OrganizationView, "counts" | "maxProxyHosts" | "maxUsers">): boolean {
  return (
    limitState(organization.counts.proxyHosts, organization.maxProxyHosts).near ||
    limitState(organization.counts.users, organization.maxUsers).near
  );
}

/** What an allowed-upstream entry admits, in words. */
export function upstreamMeaning(entry: string): string {
  if (entry === "*") return "Any network address, including your internal services";
  if (entry.startsWith("*.")) return `Any name under ${entry.slice(2)}, any depth`;
  if (/\/\d{1,3}$/.test(entry)) return "Any address in this range";
  if (/^[\d.]+$/.test(entry) || entry.includes(":")) return "This address only";
  return "This host name only";
}

function Meter({ label, state, enabled, thick = false }: { label: string; state: LimitState; enabled: boolean; thick?: boolean }) {
  if (state.max === null) return null;
  const warn = enabled && state.near;
  return (
    <span
      role="meter"
      aria-label={`${label}: ${state.used} of ${state.max}`}
      aria-valuemin={0}
      aria-valuemax={state.max}
      aria-valuenow={Math.min(state.used, state.max)}
      className={cn("block overflow-hidden rounded-full bg-raise", thick ? "h-2" : "h-1.5")}
    >
      <span
        className={cn("block h-full", !enabled ? "bg-soft" : warn ? "bg-warn" : "bg-muted-foreground")}
        style={{ width: `${Math.round(state.ratio * 100)}%` }}
      />
    </span>
  );
}

/** The list's small bar: "5 of 6" over a 6px track, warning colours near the limit. */
function LimitBar({ label, state, enabled }: { label: string; state: LimitState; enabled: boolean }) {
  if (state.max === null) {
    return (
      <span className="flex flex-col gap-0.5">
        <span className="num">{state.used}</span>
        <span className="text-xs text-soft">No limit</span>
      </span>
    );
  }
  const warn = enabled && state.near;
  return (
    <span className="flex flex-col gap-[5px]">
      <span className="flex items-baseline justify-between gap-2">
        <span className={cn("num", warn && "font-semibold text-warn")}>
          {state.used} of {state.max}
        </span>
        {warn && <span className="text-xs text-warn">{state.reached ? "Limit reached" : `${state.max - state.used} left`}</span>}
      </span>
      <Meter label={label} state={state} enabled={enabled} />
    </span>
  );
}

/** The opened organisation's limit: big figure, 8px meter and what it means. */
function LimitMeter({ label, noun, state, enabled }: { label: string; noun: string; state: LimitState; enabled: boolean }) {
  const warn = enabled && state.near;
  let note: string;
  if (state.max === null) note = `No limit on ${noun}.`;
  else if (state.reached) note = `Limit reached: new ${noun} are refused until you raise it.`;
  else if (state.near) note = `${state.max - state.used} left before new ${noun} are refused.`;
  else note = `${state.max - state.used} left.`;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-baseline gap-2">
        <span className="flex-1 text-[13px] text-muted-foreground">{label}</span>
        <span className={cn("num text-lg leading-6", warn ? "text-warn" : "text-foreground")}>{state.used}</span>
        <span className="num text-[13px] text-soft">{state.max === null ? "no limit" : `of ${state.max}`}</span>
      </span>
      <Meter label={label} state={state} enabled={enabled} thick />
      <span className={cn("text-xs", warn ? "text-warn" : "text-soft")}>{note}</span>
    </div>
  );
}

function initials(member: OrganizationMemberItem): string {
  const source = (member.name ?? member.email).trim();
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

function memberLine(member: OrganizationMemberItem, organizationEnabled: boolean, now: Date): string {
  if (!organizationEnabled) return "Cannot sign in: organisation disabled";
  if (member.status !== "active") return "Account disabled";
  const parts: string[] = [];
  if (member.lastSignInAt) parts.push(`Signed in ${when(member.lastSignInAt, now)}`);
  else if (member.apiTokens > 0) {
    parts.push(
      `${member.apiTokens} API token${member.apiTokens === 1 ? "" : "s"}${member.tokenLastUsedAt ? ` · used ${when(member.tokenLastUsedAt, now)}` : ""}`
    );
  } else parts.push("Not signed in yet");
  if (member.mfa) parts.push("MFA on");
  return parts.join(" · ");
}

export default function OrganizationsClient({
  data,
  movable,
  configurable,
  editionLabel,
  canWrite,
  allowed = { proxyHosts: true, users: true, createUsers: true },
  view = "all",
  onSetView,
  now: nowIso,
}: Props) {
  const router = useRouter();
  const branding = useBranding();
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState<OrganizationView | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<OrganizationView | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, Set<number>>>({});
  const [moveFilter, setMoveFilter] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ShowFilter>("all");

  const organizations = data.organizations;
  const names = useMemo(() => new Map(organizations.map((organization) => [organization.id, organization.name])), [organizations]);
  const opened = data.selected ? organizations.find((organization) => organization.id === data.selected?.id) ?? null : null;
  const usageMonth = data.usage?.billing ?? null;

  const counts = {
    all: organizations.length,
    near: organizations.filter(isNearLimit).length,
    disabled: organizations.filter((organization) => !organization.enabled).length,
  };
  const needle = search.trim().toLowerCase();
  const visible = organizations.filter((organization) => {
    if (filter === "near" && !isNearLimit(organization)) return false;
    if (filter === "disabled" && organization.enabled) return false;
    if (!needle) return true;
    return (
      organization.name.toLowerCase().includes(needle) ||
      organization.slug.includes(needle) ||
      organization.allowedUpstreams.some((entry) => entry.includes(needle))
    );
  });

  function run(action: () => Promise<string>) {
    setMessage(null);
    startTransition(async () => {
      try {
        setMessage({ ok: true, text: await action() });
        router.refresh();
      } catch (error) {
        setMessage({ ok: false, text: (error as Error).message });
      }
    });
  }

  function openEditor(target: OrganizationView | "new") {
    setEditing(target);
    setDraft(draftOf(target === "new" ? null : target));
    setDialogError(null);
  }

  function save() {
    if (!editing) return;
    const body = draftBody(draft);
    setDialogError(null);
    startTransition(async () => {
      try {
        if (editing === "new") {
          const created = (await send("/api/v1/organizations", "POST", body)) as { id?: number } | null;
          setEditing(null);
          setMessage({ ok: true, text: `Created organisation "${draft.name}".` });
          if (created && typeof created.id === "number") router.push(`/organizations?organization=${created.id}`, { scroll: false });
          else router.refresh();
          return;
        }
        await send(`/api/v1/organizations/${editing.id}`, "PATCH", body);
        setMessage({ ok: true, text: `Saved "${draft.name}".` });
        setEditing(null);
        router.refresh();
      } catch (error) {
        setDialogError((error as Error).message);
      }
    });
  }

  function toggle(organization: OrganizationView) {
    run(async () => {
      await send(`/api/v1/organizations/${organization.id}`, "PATCH", { enabled: !organization.enabled });
      return organization.enabled
        ? `Disabled "${organization.name}": its users cannot sign in; its hosts keep serving.`
        : `Enabled "${organization.name}".`;
    });
  }

  function remove() {
    if (!deleting) return;
    const target = deleting;
    setDialogError(null);
    startTransition(async () => {
      try {
        await send(`/api/v1/organizations/${target.id}`, "DELETE");
        setDeleting(null);
        setMessage({ ok: true, text: `Deleted organisation "${target.name}".` });
        if (data.selected?.id === target.id) router.push("/organizations", { scroll: false });
        else router.refresh();
      } catch (error) {
        setDialogError((error as Error).message);
      }
    });
  }

  function openMove(destination: string) {
    setMoving(destination);
    setSelected({});
    setMoveFilter("");
    setDialogError(null);
  }

  function toggleRow(kind: string, id: number, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current[kind] ?? []);
      if (checked) next.add(id);
      else next.delete(id);
      return { ...current, [kind]: next };
    });
  }

  function move() {
    if (moving === null) return;
    const destination = moving === PROVIDER ? null : Number(moving);
    const body: Record<string, unknown> = { organizationId: destination };
    for (const kind of MOVABLE_KINDS) body[kind.field] = [...(selected[kind.key] ?? [])];
    setDialogError(null);
    startTransition(async () => {
      try {
        const result = (await send("/api/v1/organizations/move", "POST", body)) as Record<string, number>;
        const moved = MOVABLE_KINDS.reduce((sum, kind) => sum + (result[kind.field] ?? 0), 0);
        const removed = (result.removedGrants ?? 0) + (result.removedMemberships ?? 0);
        setMoving(null);
        setMessage({
          ok: true,
          text:
            `Moved ${moved} item(s) to ${destination === null ? "the provider level" : `"${names.get(destination)}"`}.` +
            (removed > 0 ? ` Removed ${removed} group membership(s) or forward-auth grant(s) that would have crossed organisations.` : ""),
        });
        router.refresh();
      } catch (error) {
        setDialogError((error as Error).message);
      }
    });
  }

  /** Switches the dashboard to `value` ("all" or an organisation id), then optionally opens `href`. */
  function setView(value: string, href?: string) {
    if (!onSetView) return;
    setMessage(null);
    startTransition(async () => {
      try {
        await onSetView(value);
        if (href) {
          router.push(href);
          return;
        }
        setMessage({
          ok: true,
          text: value === "all" ? "The dashboard shows every organisation again." : `The dashboard now shows only "${names.get(Number(value)) ?? value}".`,
        });
        router.refresh();
      } catch (error) {
        setMessage({ ok: false, text: (error as Error).message });
      }
    });
  }

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Platform", "Organisations"]}
        title={
          <>
            Organisations
            <span className="num rounded-full bg-raise px-2 text-[13px] leading-[22px] font-semibold tracking-normal text-muted-foreground">
              {organizations.length}
            </span>
            <span className="rounded-full border border-line2 px-2 text-xs leading-[22px] font-semibold tracking-normal text-brand">
              {editionLabel} edition
            </span>
          </>
        }
        description="Client organisations with their own administrators, hosts, certificates, access lists and usage. Their users never see or reach another organisation."
        actions={
          <>
            {usageMonth && organizations.length > 0 && (
              <Button variant="outline" asChild>
                <a href={`/api/v1/usage-reports?month=${usageMonth.month}&format=csv`} download>
                  <Download aria-hidden="true" />
                  Usage report, {usageMonth.label}
                </a>
              </Button>
            )}
            {canWrite && configurable && (
              <Button onClick={() => openEditor("new")}>
                <Plus aria-hidden="true" />
                New organisation
              </Button>
            )}
          </>
        }
      />

      {!configurable && (
        <Banner tone="info" title={`Multi-tenancy needs a ${branding.productName} ${editionLabel} license or higher.`}>
          {organizations.length > 0
            ? "Organisations that exist stay isolated and their users keep signing in; you can still disable and delete them and move rows out to the provider level. "
            : ""}
          <Link href="/license" className="text-brand underline underline-offset-4">
            Manage the license
          </Link>
          .
        </Banner>
      )}
      {message && (
        <Banner tone={message.ok ? "ok" : "bad"} live onDismiss={() => setMessage(null)}>
          {message.text}
        </Banner>
      )}

      {organizations.length === 0 ? (
        <section aria-label="Organisations" className="rounded-2xl border border-line bg-panel">
          <EmptyState
            icon={Building2}
            title="No organisations yet"
            description="Everything belongs to the provider level. An organisation gives a client its own administrators, hosts, certificates and usage report."
            action={
              canWrite && configurable ? (
                <Button onClick={() => openEditor("new")}>
                  <Plus aria-hidden="true" />
                  New organisation
                </Button>
              ) : undefined
            }
          />
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            <SearchField
              aria-label="Filter organisations"
              type="search"
              placeholder="Name, slug or upstream"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-w-0 max-w-none flex-[1_1_280px]"
            />
            <SegmentedControl<ShowFilter>
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: <>All <span className="num">{counts.all}</span></> },
                {
                  value: "near",
                  label: (
                    <>
                      Near a limit <span className={cn("num", counts.near > 0 && "text-warn")}>{counts.near}</span>
                    </>
                  ),
                },
                { value: "disabled", label: <>Disabled <span className="num">{counts.disabled}</span></> },
              ]}
            />
          </div>

          <OrganizationsTable
            organizations={visible}
            selectedId={data.selected?.id ?? null}
            usageLabel={usageMonth ? shortMonth(usageMonth.month) : null}
            canWrite={canWrite}
            configurable={configurable}
            pending={pending}
            now={now}
            onMoveIn={(organization) => openMove(String(organization.id))}
            onEdit={openEditor}
            onToggle={toggle}
            onDelete={(organization) => {
              setDialogError(null);
              setDeleting(organization);
            }}
            footer={
              <>
                <span>
                  Provider level: <span className="num">{formatCount(data.provider.proxyHosts)}</span> host
                  {data.provider.proxyHosts === 1 ? "" : "s"} and <span className="num">{formatCount(data.provider.users)}</span> user
                  {data.provider.users === 1 ? "" : "s"} that belong to no organisation.
                </span>
                {canWrite && (
                  <Button variant="link" className="ml-auto h-auto p-0 text-[13px]" disabled={pending} onClick={() => openMove(PROVIDER)}>
                    Move rows to the provider level
                  </Button>
                )}
              </>
            }
          />

          {opened && data.selected && (
            <OrganizationPanel
              organization={opened}
              detail={data.selected}
              usage={data.usage}
              canWrite={canWrite}
              configurable={configurable}
              allowed={allowed}
              viewing={view === String(opened.id)}
              canSetView={Boolean(onSetView)}
              pending={pending}
              now={now}
              onSetView={setView}
              onMoveIn={() => openMove(String(opened.id))}
              onEdit={() => openEditor(opened)}
              onToggle={() => toggle(opened)}
            />
          )}
        </>
      )}

      <OrganizationEditDialog
        open={editing !== null}
        creating={editing === "new"}
        draft={draft}
        onDraftChange={setDraft}
        onClose={() => setEditing(null)}
        onSave={save}
        pending={pending}
        error={dialogError}
      />
      <OrganizationDeleteDialog organization={deleting} onClose={() => setDeleting(null)} onDelete={remove} pending={pending} error={dialogError} />
      <OrganizationMoveDialog
        moving={moving}
        organizations={organizations}
        movable={movable}
        selected={selected}
        filter={moveFilter}
        onFilterChange={setMoveFilter}
        onDestinationChange={openMove}
        onToggleRow={toggleRow}
        onClose={() => setMoving(null)}
        onMove={move}
        pending={pending}
        error={dialogError}
      />
    </div>
  );
}

function OrganizationsTable({
  organizations,
  selectedId,
  usageLabel,
  canWrite,
  configurable,
  pending,
  now,
  onMoveIn,
  onEdit,
  onToggle,
  onDelete,
  footer,
}: {
  organizations: OrganizationListItem[];
  selectedId: number | null;
  /** "Sep": the billing month's column; null hides it (no usage permission). */
  usageLabel: string | null;
  canWrite: boolean;
  configurable: boolean;
  pending: boolean;
  now: Date;
  onMoveIn: (organization: OrganizationView) => void;
  onEdit: (organization: OrganizationView) => void;
  onToggle: (organization: OrganizationView) => void;
  onDelete: (organization: OrganizationView) => void;
  footer: ReactNode;
}) {
  const head = "border-b border-line px-2.5 py-2.5 text-left text-xs font-medium text-soft";
  return (
    <section aria-label="Organisations" className="overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-[13px]">
          <thead>
            <tr>
              <th scope="col" className={cn(head, "pl-[18px]")}>
                Organisation
              </th>
              <th scope="col" className={cn(head, "w-[170px]")}>
                Proxy hosts
              </th>
              <th scope="col" className={cn(head, "w-[170px]")}>
                Users
              </th>
              <th scope="col" className={head}>
                Allowed upstreams
              </th>
              {usageLabel && (
                <th scope="col" className={cn(head, "text-right")}>
                  Requests, {usageLabel}
                </th>
              )}
              <th scope="col" className={head}>
                Status
              </th>
              {canWrite && (
                <th scope="col" className={cn(head, "w-12 pr-[18px]")}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {organizations.length === 0 && (
              <tr>
                <td colSpan={7} className="px-[18px] py-6 text-center text-muted-foreground">
                  No organisations match.
                </td>
              </tr>
            )}
            {organizations.map((organization) => {
              const isSelected = organization.id === selectedId;
              return (
                <tr
                  key={organization.id}
                  data-testid={`organization-${organization.slug}`}
                  className={cn("border-b border-line transition-colors last:border-0", isSelected ? "bg-brand-tint" : "hover:bg-panel2")}
                >
                  <td className="py-3 pr-2.5 pl-[18px]">
                    <span className="flex flex-col gap-0.5">
                      <Link
                        href={`/organizations?organization=${organization.id}`}
                        scroll={false}
                        aria-current={isSelected ? "true" : undefined}
                        className="font-semibold text-foreground underline-offset-4 hover:underline"
                      >
                        {organization.name}
                      </Link>
                      <span className="num text-xs text-soft">{organization.slug}</span>
                    </span>
                  </td>
                  <td className="px-2.5 py-3">
                    <LimitBar label="Proxy hosts" state={limitState(organization.counts.proxyHosts, organization.maxProxyHosts)} enabled={organization.enabled} />
                  </td>
                  <td className="px-2.5 py-3">
                    <LimitBar label="Users" state={limitState(organization.counts.users, organization.maxUsers)} enabled={organization.enabled} />
                  </td>
                  <td className="max-w-[320px] px-2.5 py-3">
                    {organization.allowedUpstreams.length === 0 ? (
                      <span className="text-xs text-warn">None yet: cannot add hosts</span>
                    ) : (
                      <span className="num line-clamp-2 text-xs break-all text-muted-foreground" title={organization.allowedUpstreams.join(", ")}>
                        {organization.allowedUpstreams.join(", ")}
                      </span>
                    )}
                  </td>
                  {usageLabel && (
                    <td className="num px-2.5 py-3 text-right">
                      {organization.requests ? formatCount(organization.requests) : <span className="text-soft">—</span>}
                    </td>
                  )}
                  <td className="px-2.5 py-3">
                    {organization.enabled ? (
                      <StatusDot tone="ok" label="Enabled" />
                    ) : (
                      <span className="flex flex-col gap-0.5">
                        <StatusDot tone="off" label="Disabled" />
                        {organization.disabledSince && <span className="text-xs text-soft">since {shortDate(organization.disabledSince, now)}</span>}
                      </span>
                    )}
                  </td>
                  {canWrite && (
                    <td className="py-3 pr-[18px] pl-1.5 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${organization.name}`} disabled={pending}>
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem disabled={!configurable} onClick={() => onMoveIn(organization)}>
                            Move rows in
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={!configurable} onClick={() => onEdit(organization)}>
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={!configurable && !organization.enabled} onClick={() => onToggle(organization)}>
                            {organization.enabled ? "Disable" : "Enable"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-bad focus:text-bad" onClick={() => onDelete(organization)}>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-[18px] py-3 text-[13px] text-muted-foreground">{footer}</div>
    </section>
  );
}

function OrganizationPanel({
  organization,
  detail,
  usage,
  canWrite,
  configurable,
  allowed,
  viewing,
  canSetView,
  pending,
  now,
  onSetView,
  onMoveIn,
  onEdit,
  onToggle,
}: {
  organization: OrganizationListItem;
  detail: OrganizationDetail;
  usage: OrganizationsPageData["usage"];
  canWrite: boolean;
  configurable: boolean;
  allowed: Allowed;
  /** The dashboard shows only this organisation now. */
  viewing: boolean;
  canSetView: boolean;
  pending: boolean;
  now: Date;
  onSetView: (value: string, href?: string) => void;
  onMoveIn: () => void;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const id = String(organization.id);
  const hostsLimit = limitState(organization.counts.proxyHosts, organization.maxProxyHosts);
  const usersLimit = limitState(organization.counts.users, organization.maxUsers);
  const noUpstreams = organization.allowedUpstreams.length === 0;
  const note = [`Since ${longDate(organization.createdAt)}`, organization.notes].filter(Boolean).join(" · ");
  const linkButton = "h-auto p-0 text-[13px]";

  return (
    <section aria-labelledby="organization-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 pt-1">
        <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 id="organization-title" className="m-0 text-xl leading-7 font-semibold tracking-[-0.01em]">
              {organization.name}
            </h2>
            <Badge variant={organization.enabled ? "success" : "muted"} className="font-semibold">
              <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", organization.enabled ? "bg-ok" : "bg-soft")} />
              {organization.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <span className="num text-[13px] text-soft">{organization.slug}</span>
          </div>
          <span className="text-[13px] break-words text-muted-foreground">{note}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSetView && (
            <Button variant="outline" disabled={pending} onClick={() => onSetView(viewing ? "all" : id)}>
              <Filter aria-hidden="true" />
              {viewing ? "Show every organisation" : "Show only this organisation"}
            </Button>
          )}
          {canWrite && (
            <>
              <Button variant="outline" disabled={pending || !configurable} onClick={onMoveIn}>
                Move rows in
              </Button>
              <Button variant="outline" disabled={pending || !configurable} onClick={onEdit}>
                Edit
              </Button>
              <Button
                variant={organization.enabled ? "danger" : "outline"}
                disabled={pending || (!configurable && !organization.enabled)}
                onClick={onToggle}
              >
                {organization.enabled ? "Disable" : "Enable"}
              </Button>
            </>
          )}
        </div>
      </div>

      {!organization.enabled ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl border border-line2 bg-raise px-4 py-3 text-sm">
          <Info aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
          <p className="m-0 min-w-0 flex-[1_1_420px]">
            <span className="font-semibold">
              {organization.disabledSince ? `Disabled since ${longDate(organization.disabledSince)}.` : "Disabled."}
            </span>{" "}
            <span className="text-muted-foreground">
              Its users cannot sign in, their API tokens stop working and forward auth refuses them. Its hosts keep serving
              traffic; disable them separately if needed.
            </span>
          </p>
        </div>
      ) : (
        noUpstreams && (
          <Banner tone="warn" title="No allowed upstreams yet.">
            An empty list allows nothing, so this organisation cannot proxy anywhere until you decide where it may.
          </Banner>
        )
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-3">
        <SectionCard title="Limits" headingLevel={3} divided={false} contentClassName="flex flex-col gap-3.5 px-[18px] pb-4">
          <LimitMeter label="Proxy hosts" noun="hosts" state={hostsLimit} enabled={organization.enabled} />
          <LimitMeter label="Users" noun="users" state={usersLimit} enabled={organization.enabled} />
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line pt-2.5 text-[13px] text-muted-foreground">
            <span>
              Certificates <span className="num text-foreground">{organization.counts.certificates}</span>
            </span>
            <span>
              Access lists <span className="num text-foreground">{organization.counts.accessLists}</span>
            </span>
            <span>
              Groups <span className="num text-foreground">{organization.counts.groups}</span>
            </span>
          </div>
        </SectionCard>

        <SectionCard
          title="Allowed upstreams"
          headingLevel={3}
          divided={false}
          actions={
            canWrite && configurable ? (
              <Button variant="link" className={linkButton} onClick={onEdit} aria-label="Edit allowed upstreams">
                Edit
              </Button>
            ) : undefined
          }
          contentClassName="flex flex-col gap-3 px-[18px] pb-4"
        >
          {noUpstreams ? (
            <p className="m-0 text-[13px] text-muted-foreground">
              None yet. An empty list allows nothing, so its users cannot add a host until you add an entry.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {organization.allowedUpstreams.map((entry) => (
                <li key={entry} className="flex flex-col gap-0.5 rounded-lg border border-line bg-panel2 px-2.5 py-2">
                  <span className="num text-[13px] break-all">{entry}</span>
                  <span className="text-xs text-soft">{upstreamMeaning(entry)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-xs text-soft">
            Organisation users can proxy only to these. Unix sockets, Caddy placeholders and port 2019 are never allowed.
          </p>
        </SectionCard>

        <SectionCard
          title={usage ? `Usage, ${usage.billing.label}` : "Usage"}
          headingLevel={3}
          divided={false}
          actions={
            usage ? (
              <a
                href={`/api/v1/usage-reports?month=${usage.billing.month}&organizationId=${organization.id}&format=csv`}
                download
                className="text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline"
                aria-label={`Download the ${usage.billing.label} usage of ${organization.name} as CSV`}
              >
                CSV
              </a>
            ) : undefined
          }
          contentClassName="flex flex-col gap-3 px-[18px] pb-4"
        >
          {usage && detail.usage ? (
            <>
              <dl className="m-0 grid grid-cols-2 gap-3">
                {[
                  { label: "Requests", value: formatCount(detail.usage.requests) },
                  { label: "Bandwidth", value: formatBytes(detail.usage.bytes) },
                  { label: "WAF blocks", value: formatCount(detail.usage.wafBlocks) },
                  { label: "Hosts enabled", value: `${detail.usage.enabledProxyHosts} of ${detail.usage.proxyHosts}` },
                ].map((item) => (
                  <div key={item.label} className="flex min-w-0 flex-col gap-0.5">
                    <dt className="text-xs text-soft">{item.label}</dt>
                    <dd className="num m-0 text-xl leading-7">{item.value}</dd>
                  </div>
                ))}
              </dl>
              <p className="m-0 text-xs text-soft">
                {usage.analyticsAvailable ? (
                  <>
                    Counted over the host names it serves now, from analytics. {usage.current.label} so far:{" "}
                    <span className="num">{formatCount(detail.currentRequests ?? 0)}</span> requests.
                  </>
                ) : (
                  "Analytics are off, so requests, bandwidth and WAF blocks show 0."
                )}
              </p>
            </>
          ) : (
            <p className="m-0 text-[13px] text-muted-foreground">Your role cannot read usage reports.</p>
          )}
        </SectionCard>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <SectionCard
          title="Hosts"
          headingLevel={3}
          count={detail.hostsTotal}
          className="min-w-0 flex-[2_1_560px]"
          actions={
            allowed.proxyHosts && detail.hostsTotal > 0 && canSetView ? (
              <Button variant="link" className={linkButton} disabled={pending} onClick={() => onSetView(id, "/proxy-hosts")}>
                Open in proxy hosts
              </Button>
            ) : undefined
          }
          footer={
            <span className="text-xs text-soft">
              Hosts use only certificates and access lists of this organisation. Domains are unique across organisations.
            </span>
          }
        >
          {detail.hosts === null ? (
            <p className="m-0 px-[18px] py-4 text-[13px] text-muted-foreground">Your role cannot read proxy hosts.</p>
          ) : detail.hosts.length === 0 ? (
            <EmptyState
              compact
              headingLevel={4}
              title="No hosts yet"
              description={
                noUpstreams
                  ? "Add an allowed upstream first, then create a host while the dashboard shows this organisation."
                  : "Create a host while the dashboard shows this organisation, or move hosts in."
              }
              action={
                canWrite && configurable ? (
                  noUpstreams ? (
                    <Button variant="secondary" size="sm" onClick={onEdit}>
                      Add allowed upstream
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={onMoveIn}>
                      Move hosts in
                    </Button>
                  )
                ) : undefined
              }
            />
          ) : (
            <ul className="m-0 list-none p-0">
              {detail.hosts.map((host) => (
                <li key={host.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-[18px] py-3 last:border-0">
                  <span className="flex min-w-0 flex-[2_1_240px] flex-col gap-0.5">
                    <Link
                      href={`/proxy-hosts?search=${encodeURIComponent(host.domain)}`}
                      className="truncate font-semibold text-foreground underline-offset-4 hover:underline"
                    >
                      {host.domain}
                    </Link>
                    <span className="num truncate text-xs text-soft">
                      {host.upstream ?? "No upstream"}
                      {host.moreUpstreams > 0 ? ` +${host.moreUpstreams}` : ""}
                      {host.moreDomains > 0 ? ` · ${host.moreDomains} more domain${host.moreDomains === 1 ? "" : "s"}` : ""}
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-[2_1_200px] flex-wrap gap-1">
                    {!host.enabled && <ProtectionPill color="var(--soft)" label="Host disabled" />}
                    {host.protections.map((pill) => (
                      <ProtectionPill key={pill.label} kind={pill.kind} label={pill.label} />
                    ))}
                    {host.enabled && host.protections.length === 0 && <span className="text-xs text-soft">No protections</span>}
                  </span>
                  {host.requests !== null && usage && (
                    <span className="flex flex-[0_0_96px] flex-col items-end gap-0.5">
                      <span className="num">{formatCount(host.requests)}</span>
                      <span className="text-xs text-soft">in {shortMonth(usage.billing.month)}</span>
                    </span>
                  )}
                </li>
              ))}
              {detail.hostsTotal > detail.hosts.length && (
                <li className="px-[18px] py-3 text-[13px] text-muted-foreground">
                  And <span className="num">{detail.hostsTotal - detail.hosts.length}</span> more in proxy hosts.
                </li>
              )}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Members"
          headingLevel={3}
          count={detail.members.length}
          className="min-w-0 flex-[1_1_320px]"
          actions={
            // Creating a user inside an organisation needs organizations:write and the license too.
            allowed.createUsers && canWrite && configurable && canSetView ? (
              <Button variant="link" className={linkButton} disabled={pending} onClick={() => onSetView(id, "/users")}>
                Add user
              </Button>
            ) : undefined
          }
          footer={
            <span className="text-xs text-soft">
              Organisation admins manage its hosts, certificates, access lists, groups and users. Users and viewers sign in to its
              hosts only.
            </span>
          }
        >
          {detail.members.length === 0 ? (
            <EmptyState compact headingLevel={4} title="No members yet" description="Users created while the dashboard shows this organisation join it." />
          ) : (
            <ul className="m-0 list-none py-1">
              {detail.members.map((member) => (
                <li key={member.id} className="flex items-center gap-3 px-[18px] py-2.5">
                  <span
                    aria-hidden="true"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-raise text-[11px] font-semibold text-muted-foreground"
                  >
                    {initials(member)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className={cn(
                        "num truncate text-[13px]",
                        organization.enabled && member.status === "active" ? "text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {member.email}
                    </span>
                    <span className="text-xs text-soft">{memberLine(member, organization.enabled, now)}</span>
                  </span>
                  <Badge variant={member.roleKind === "org_admin" ? "default" : "muted"} className="font-semibold">
                    {member.roleLabel}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </section>
  );
}
