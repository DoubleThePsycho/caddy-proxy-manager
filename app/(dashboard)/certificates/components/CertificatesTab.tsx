"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal, Search, ShieldCheck } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ExpiryTimeline, type ExpiryItem } from "@/components/ui/ExpiryTimeline";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  RENEWAL_WINDOW_DAYS,
  isHealthy,
  needsAttention,
  type CertificateOverviewRow,
} from "@/src/lib/certificate-renewal";
import { deleteCertificateAction } from "../actions";
import {
  daysLeftText,
  expiryToneFor,
  formatDate,
  obtainedView,
  renewalView,
  rowSearchText,
  timelineDetail,
  usedBySummary,
  userHref,
} from "../format";
import type { ImportedCertView } from "../page";
import { HostsCell } from "./HostsCell";

const PAGE_SIZE = 50;
const TIMELINE_DAYS = 90;

type StatusFilter = "all" | "due" | "ok";

type Props = {
  rows: CertificateOverviewRow[];
  generatedAt: string;
  canWrite: boolean;
  acmeEmail: string | null;
  onEditImported: (cert: ImportedCertView) => void;
};

function rowDomId(row: CertificateOverviewRow): string {
  return `certificate-row-${row.id.replace(/[^a-z0-9-]/gi, "-")}`;
}

function rowLabel(row: CertificateOverviewRow): string {
  return row.domains[0] ?? row.name;
}

export function CertificatesTab({ rows, generatedAt, canWrite, acmeEmail, onEditImported }: Props) {
  const now = new Date(generatedAt).getTime();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState<CertificateOverviewRow | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        if (status === "due" && !needsAttention(row)) return false;
        if (status === "ok" && !isHealthy(row)) return false;
        return !q || rowSearchText(row).includes(q);
      }),
    [rows, status, q]
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const dueCount = rows.filter(needsAttention).length;
  const healthyCount = rows.filter(isHealthy).length;
  const timelineRows = rows.filter((row) => row.daysLeft !== null && row.renewal.state !== "inactive");
  const laterCount = timelineRows.filter((row) => (row.daysLeft ?? 0) > TIMELINE_DAYS).length;
  const unknownCount = rows.filter((row) => row.daysLeft === null && row.renewal.state === "unknown").length;
  const items: ExpiryItem[] = timelineRows.map((row) => ({
    id: row.id,
    label: rowLabel(row),
    daysLeft: row.daysLeft!,
    detail: timelineDetail(row),
    tone: expiryToneFor(row),
  }));
  const hasManaged = rows.some((row) => row.kind === "managed");
  const directory = rows.find((row) => row.obtainedBy.method === "acme" && row.obtainedBy.directory)?.obtainedBy;
  const caName = directory && directory.method === "acme" && directory.directory ? directory.directory : "Let's Encrypt";

  useEffect(() => {
    if (!selectedId) return;
    document.getElementById(`certificate-row-${selectedId.replace(/[^a-z0-9-]/gi, "-")}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  function selectFromTimeline(item: ExpiryItem) {
    if (selectedId === item.id) {
      setSelectedId(null);
      return;
    }
    // Show the row: clear the filters and turn to its page.
    setQuery("");
    setStatus("all");
    const index = rows.findIndex((row) => row.id === item.id);
    setPage(index >= 0 ? Math.floor(index / PAGE_SIZE) + 1 : 1);
    setSelectedId(item.id);
  }

  function clearFilters() {
    setQuery("");
    setStatus("all");
    setPage(1);
  }

  if (rows.length === 0) {
    return (
      <SectionCard title="Certificates" divided={false}>
        <EmptyState
          icon={ShieldCheck}
          title="No certificates yet"
          description="Caddy gets a certificate for each proxy host on its own as soon as you add one."
          action={
            <Button asChild variant="outline">
              <Link href="/proxy-hosts?create=1">Add a proxy host</Link>
            </Button>
          }
        />
      </SectionCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {hasManaged && (
        <Banner tone="info" title="Older managed certificate entries.">
          Caddy obtains these certificates on its own; the entries are left from earlier versions and can be deleted from their row menu.
        </Banner>
      )}

      <SectionCard
        title={`Expiry, next ${TIMELINE_DAYS} days`}
        description={`Let's Encrypt certificates last 90 days. Caddy renews each one when ${RENEWAL_WINDOW_DAYS} days are left.`}
        divided={false}
        contentClassName="px-5 pb-4"
      >
        {items.length === 0 ? (
          <p className="m-0 text-[13px] text-muted-foreground">
            No expiry dates are known yet. Caddy&apos;s certificates appear here once it serves them.
          </p>
        ) : (
          <ExpiryTimeline
            items={items}
            title={`Expiry, next ${TIMELINE_DAYS} days`}
            maxDays={TIMELINE_DAYS}
            renewalDays={RENEWAL_WINDOW_DAYS}
            now={now}
            selectedId={selectedId}
            onSelect={selectFromTimeline}
          />
        )}
        {(laterCount > 0 || unknownCount > 0) && (
          <p className="m-0 mt-2 text-xs text-soft">
            {laterCount > 0 && <>{laterCount} expire after {TIMELINE_DAYS} days and sit at the right edge. </>}
            {unknownCount > 0 && <>{unknownCount} not shown: their expiry is not read yet.</>}
          </p>
        )}
      </SectionCard>

      <div className="flex flex-wrap items-center gap-2.5">
        <label className="flex h-[38px] min-w-0 flex-[1_1_280px] items-center gap-2 rounded-[10px] border border-line bg-panel px-3 text-soft focus-within:border-brand">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="sr-only">Filter certificates</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Domain or host"
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-soft"
          />
        </label>
        <SegmentedControl<StatusFilter>
          label="Status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          options={[
            { value: "all", label: <>All <span className="num text-muted-foreground">{rows.length}</span></> },
            { value: "due", label: <>Due for renewal <span className="num text-warn">{dueCount}</span></> },
            { value: "ok", label: <>Healthy <span className="num text-muted-foreground">{healthyCount}</span></> },
          ]}
        />
      </div>

      <section aria-label="Certificates" className="overflow-hidden rounded-2xl border border-line bg-panel">
        <Table className="min-w-[1040px]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Domains</TableHead>
              <TableHead scope="col">Issuer</TableHead>
              <TableHead scope="col">Obtained by</TableHead>
              <TableHead scope="col">Expires</TableHead>
              <TableHead scope="col">Renewal</TableHead>
              <TableHead scope="col">Used by</TableHead>
              <TableHead scope="col" className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <CertificateTableRow
                key={row.id}
                row={row}
                now={now}
                selected={row.id === selectedId}
                canWrite={canWrite}
                onEdit={() => onEditImported({ id: row.certificateId!, name: row.name, domains: row.domains })}
                onDelete={() => setDeleting(row)}
              />
            ))}
          </TableBody>
        </Table>
        {filtered.length === 0 && (
          <div className="flex flex-wrap items-center gap-2.5 border-t border-line px-[18px] py-4 text-[13px] text-muted-foreground">
            No certificate matches these filters.
            <Button variant="secondary" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        )}
        {pageCount > 1 && (
          <div className="flex items-center justify-center gap-2 border-t border-line px-4 py-2.5">
            <Button variant="outline" size="icon-sm" onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <span className="text-[13px] text-muted-foreground">
              Page <span className="num">{currentPage}</span> of <span className="num">{pageCount}</span>
            </span>
            <Button variant="outline" size="icon-sm" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-[18px] py-3 text-xs text-soft">
          {acmeEmail && (
            <span>
              ACME account <span className="num text-muted-foreground">{acmeEmail}</span> at {caName}
            </span>
          )}
          <span>The expiry of certificates Caddy obtains is read from the certificate it serves, at most an hour old.</span>
        </div>
      </section>

      {deleting && <DeleteCertificateDialog row={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function CertificateTableRow({
  row,
  now,
  selected,
  canWrite,
  onEdit,
  onDelete,
}: {
  row: CertificateOverviewRow;
  now: number;
  selected: boolean;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const renewal = renewalView(row, now);
  const obtained = obtainedView(row.obtainedBy);
  const label = rowLabel(row);
  const extraDomains = row.domains.length - 1;
  const second =
    row.kind === "acme"
      ? row.domains[1] ?? null
      : row.name !== label
        ? row.name
        : null;
  const expiryTone =
    row.daysLeft === null ? "text-soft" : row.renewal.state === "expired" || row.renewal.state === "overdue" ? "font-semibold text-bad" : needsAttention(row) ? "font-semibold text-warn" : "text-soft";
  const hostLinks = row.usedBy.map((user) => ({
    key: `${user.kind}-${user.id}`,
    name: user.name,
    href: userHref(user),
    note: user.kind === "l4_host" ? "L4" : undefined,
  }));

  return (
    <TableRow id={rowDomId(row)} className={cn(selected && "bg-brand-tint hover:bg-brand-tint", !row.active && "text-muted-foreground")}>
      <th scope="row" className="max-w-[320px] px-3 py-2.5 text-left align-middle font-normal first:pl-4">
        <span className="flex min-w-0 flex-col">
          <span className="num truncate font-semibold text-foreground" title={row.domains.join(", ")}>
            {label}
            {row.kind === "acme" && extraDomains > 1 && <span className="ml-1.5 font-normal text-soft">+{extraDomains - 1}</span>}
            {row.kind !== "acme" && extraDomains > 0 && <span className="ml-1.5 font-normal text-soft">+{extraDomains}</span>}
          </span>
          {second && <span className={cn("truncate text-xs text-soft", row.kind === "acme" && "num")}>{second}</span>}
        </span>
      </th>
      <TableCell>
        <span className="flex flex-col">
          <span className={cn(!row.issuer && "text-soft")}>{row.issuer ?? "Unknown"}</span>
          <span className="text-xs text-soft">{row.keyType ?? (row.issuerFromCertificate ? "" : "Configured CA")}</span>
        </span>
      </TableCell>
      <TableCell>
        <span className="flex flex-col">
          <span className={cn(row.obtainedBy.method === "acme" && "num")}>{obtained.label}</span>
          <span className="text-xs text-soft">{obtained.detail}</span>
        </span>
      </TableCell>
      <TableCell>
        {row.validTo ? (
          <span className="flex flex-col">
            <span>{formatDate(row.validTo)}</span>
            <span className={cn("num text-xs", expiryTone)}>{daysLeftText(row.daysLeft!)}</span>
          </span>
        ) : (
          <span className="flex flex-col">
            <span className="text-soft">Not read yet</span>
            <span className="text-xs text-soft">{row.active ? "Shown once Caddy serves it" : "–"}</span>
          </span>
        )}
      </TableCell>
      <TableCell>
        <span className="flex flex-col">
          <StatusDot tone={renewal.tone} label={renewal.label} className={cn(renewal.tone !== "ok" && renewal.tone !== "off" && "font-semibold")} />
          <span className="text-xs text-soft">{renewal.detail}</span>
        </span>
      </TableCell>
      <TableCell>
        <HostsCell hosts={hostLinks} summary={row.usedBy.length > 0 ? usedBySummary(row.usedBy) : undefined} emptyText="Not used" />
      </TableCell>
      <TableCell className="text-right">
        <RowActions row={row} canWrite={canWrite} onEdit={onEdit} onDelete={onDelete} />
      </TableCell>
    </TableRow>
  );
}

function RowActions({
  row,
  canWrite,
  onEdit,
  onDelete,
}: {
  row: CertificateOverviewRow;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const host = row.kind === "acme" ? row.usedBy.find((user) => user.kind === "proxy_host" && user.id === row.hostId) : null;
  const editable = canWrite && row.kind === "imported";
  const deletable = canWrite && row.kind !== "acme";
  if (!host && !editable && !deletable) return null;
  const name = row.kind === "acme" ? rowLabel(row) : row.name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {host && (
          <DropdownMenuItem asChild>
            <Link href={userHref(host)}>Open proxy host</Link>
          </DropdownMenuItem>
        )}
        {editable && <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>}
        {deletable && (
          <DropdownMenuItem className="text-bad focus:text-bad" onSelect={onDelete}>
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteCertificateDialog({ row, onClose }: { row: CertificateOverviewRow; onClose: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const imported = row.kind === "imported";

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await deleteCertificateAction(row.certificateId!);
        if (result.ok) onClose();
        else setError(result.error);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete certificate");
      }
    });
  }

  return (
    <AppDialog
      open
      onClose={() => {
        if (!isPending) onClose();
      }}
      title={imported ? "Delete imported certificate" : "Delete certificate entry"}
      maxWidth="sm"
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleDelete} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete certificate"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-muted-foreground">
          Delete <strong className="text-foreground">{row.name}</strong>? This cannot be undone.
          {row.usedBy.length > 0 && ` ${row.usedBy.length === 1 ? "1 host uses" : `${row.usedBy.length} hosts use`} it.`}
        </p>
        {row.usedBy.some((user) => user.kind === "proxy_host") && (
          <p className="m-0 text-sm text-muted-foreground">
            Proxy hosts that use it switch to automatic TLS: Caddy obtains a certificate for their names, which needs
            their domains to reach this server (or a DNS provider for DNS-01).
          </p>
        )}
        {error && <p className="m-0 text-sm text-bad">{error}</p>}
      </div>
    </AppDialog>
  );
}
