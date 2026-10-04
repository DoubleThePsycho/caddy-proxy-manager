"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Download, RadioTower, Search, X } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import type { AuditChainStatus } from "@/ee/audit/chain-status";
import { AuditEventsTable } from "./AuditEventsTable";
import { ChainBanner, ExportDialog } from "@/ee/audit/ui/AuditLogTools";
import { StreamingStrip } from "@/ee/audit/ui/StreamingStrip";
import {
  AUDIT_RANGES,
  RANGE_TEXT,
  auditLogHref,
  entityTypeLabel,
  hasNarrowingFilters,
  type AuditEventRow,
  type AuditFacetsView,
  type AuditFilters,
  type AuditRange,
} from "@/src/lib/audit-log-view";
import type { AuditSinkSummary } from "@/ee/audit/ui/sink-view";

type Props = {
  events: AuditEventRow[];
  /** Events matching every filter. */
  total: number;
  /** Events in the time range alone, when other filters narrow it down. */
  totalInRange: number | null;
  page: number;
  perPage: number;
  filters: AuditFilters;
  /** Messages for filters in the URL that were ignored. */
  invalidFilters?: string[];
  facets: AuditFacetsView;
  /** Whether the license allows export, verification and streaming settings. */
  licensed: boolean;
  /** Provider-level users see the hash chain (it spans every organisation). */
  providerLevel: boolean;
  chain: AuditChainStatus | null;
  /** The streaming destinations, for users who may see them; null otherwise. */
  sinks: AuditSinkSummary[] | null;
  retentionDays: number | null;
  canHistory: boolean;
  canApprovals: boolean;
  /** When the page was built; lags are measured against it. */
  generatedAt: string;
};

const fieldClass =
  "flex h-[38px] items-center gap-2 rounded-[10px] border border-line bg-panel text-[13px] focus-within:border-brand";

function FilterSelect({
  label,
  value,
  onChange,
  anyLabel,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  anyLabel: string;
  options: { value: string; label: string }[];
}) {
  const known = value === "" || options.some((option) => option.value === value);
  return (
    <label className={cn(fieldClass, "pr-1 pl-3")}>
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 max-w-[220px] cursor-pointer border-0 bg-transparent text-[13px] text-foreground outline-none"
      >
        <option value="">{anyLabel}</option>
        {!known && <option value={value}>{value}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function AuditLogClient({
  events,
  total,
  totalInRange,
  page,
  perPage,
  filters,
  invalidFilters = [],
  facets,
  licensed,
  providerLevel,
  chain,
  sinks,
  retentionDays,
  canHistory,
  canApprovals,
  generatedAt,
}: Props) {
  const router = useRouter();
  const pathname = usePathname() || "/audit-log";
  const format = useFormat();
  const [query, setQuery] = useState(filters.q);
  const [exportOpen, setExportOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setQuery(filters.q);
  }, [filters.q]);
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  /** Every change of the filters starts again at the first page. */
  function navigate(patch: Partial<AuditFilters>) {
    router.push(auditLogHref({ ...filters, page: 1, ...patch }, pathname), { scroll: false });
  }

  function search(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => navigate({ q: value }), 400);
  }

  function clearFilters() {
    setQuery("");
    navigate({ q: "", actor: "", action: "", entityType: "", entityId: "", from: "", to: "" });
  }

  const customPeriod = Boolean(filters.from || filters.to);
  const rangeText = customPeriod ? "in the chosen period" : RANGE_TEXT[filters.range];
  const narrowed = hasNarrowingFilters(filters);
  const eventsWord = (count: number) => `${format.number(count)} ${count === 1 ? "event" : "events"}`;
  const countText =
    narrowed && totalInRange !== null
      ? `${format.number(total)} of ${eventsWord(totalInRange)}${rangeText ? ` ${rangeText}` : ""} match`
      : `${eventsWord(total)}${rangeText ? ` ${rangeText}` : ""}`;
  const firstShown = total === 0 ? 0 : (page - 1) * perPage + 1;
  const lastShown = Math.min(total, (page - 1) * perPage + events.length);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const anyFilter = narrowed || customPeriod;

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Observe", "Audit log"]}
        title="Audit log"
        description="Every change, sign-in and check, linked into a tamper-evident hash chain."
        actions={
          <>
            {sinks !== null && (
              <Button asChild variant="outline">
                <Link href="/audit-log/streaming">
                  <RadioTower />
                  Streaming and retention
                </Link>
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => setExportOpen(true)}
              disabled={!licensed}
              title={licensed ? undefined : "Exporting needs a Business license"}
            >
              <Download />
              Export CSV or JSON
            </Button>
          </>
        }
      />

      {!licensed && (
        <Banner tone="info">
          Export, integrity verification, streaming and retention need a Business license.{" "}
          <Link href="/license" className="text-brand underline underline-offset-4">
            Manage the license
          </Link>
        </Banner>
      )}

      {providerLevel && chain && <ChainBanner chain={chain} licensed={licensed} />}

      {invalidFilters.length > 0 && (
        <Banner tone="warn" title="Some filters were ignored.">
          {invalidFilters.join(". ")}.
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-2.5" role="search" aria-label="Filter the audit log">
        <label className={cn(fieldClass, "min-w-0 flex-[1_1_260px] px-3 text-soft")}>
          <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="sr-only">Search the audit log</span>
          <input
            type="search"
            value={query}
            onChange={(event) => search(event.target.value)}
            placeholder="Search summaries, hosts, users"
            maxLength={200}
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-soft"
          />
        </label>
        <FilterSelect
          label="Actor"
          value={filters.actor}
          onChange={(actor) => navigate({ actor })}
          anyLabel="Anyone"
          options={facets.actors.map((actor) => ({ value: actor.value, label: actor.label }))}
        />
        <FilterSelect
          label="Action"
          value={filters.action}
          onChange={(action) => navigate({ action })}
          anyLabel="Any"
          options={facets.actions.map((action) => ({ value: action, label: action }))}
        />
        <FilterSelect
          label="Entity"
          value={filters.entityType}
          onChange={(entityType) => navigate({ entityType, entityId: "" })}
          anyLabel="Any"
          options={facets.entityTypes.map((type) => ({ value: type, label: entityTypeLabel(type) }))}
        />
        <SegmentedControl<AuditRange | "custom">
          label="Time range"
          mono
          value={customPeriod ? "custom" : filters.range}
          onChange={(range) => navigate({ range: range as AuditRange, from: "", to: "" })}
          options={[...AUDIT_RANGES.map((range) => ({ value: range, label: range })), { value: "all" as const, label: "All" }]}
        />
      </div>

      {(filters.entityId || customPeriod) && (
        <div className="-mt-2 flex flex-wrap items-center gap-2 text-[13px]">
          {filters.entityId && (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line2 bg-panel pr-1 pl-2.5">
              {filters.entityType ? entityTypeLabel(filters.entityType) : "Entity"} <span className="num">#{filters.entityId}</span>
              <button
                type="button"
                aria-label="Remove the entity filter"
                onClick={() => navigate({ entityId: "" })}
                className="grid h-5 w-5 place-items-center rounded-full text-muted-foreground hover:bg-raise hover:text-foreground"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          )}
          {customPeriod && (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line2 bg-panel pr-1 pl-2.5">
              {filters.from && (
                <>
                  From <span className="num">{filters.from}</span>
                </>
              )}
              {filters.from && filters.to && " "}
              {filters.to && (
                <>
                  {filters.from ? "to" : "Up to"} <span className="num">{filters.to}</span>
                </>
              )}
              <button
                type="button"
                aria-label="Remove the period"
                onClick={() => navigate({ from: "", to: "" })}
                className="grid h-5 w-5 place-items-center rounded-full text-muted-foreground hover:bg-raise hover:text-foreground"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          )}
        </div>
      )}

      <SectionCard
        title="Events"
        description={countText}
        divided={false}
        actions={
          anyFilter ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : undefined
        }
        footer={
          <div className="flex flex-wrap items-center gap-2.5 text-muted-foreground">
            <span>
              {total === 0 ? (
                "Nothing to show"
              ) : (
                <>
                  <span className="num">{format.number(firstShown)}</span> to <span className="num">{format.number(lastShown)}</span> of{" "}
                  <span className="num">{format.number(total)}</span>
                </>
              )}
            </span>
            {pages > 1 && (
              <span className="flex items-center gap-1.5">
                {page > 1 ? (
                  <Button asChild variant="outline" size="icon-sm" aria-label="Newer events">
                    <Link href={auditLogHref({ ...filters, page: page - 1 }, pathname)} scroll={false}>
                      <ChevronLeft />
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" size="icon-sm" aria-label="Newer events" disabled>
                    <ChevronLeft />
                  </Button>
                )}
                <span className="text-[13px]">
                  Page <span className="num">{page}</span> of <span className="num">{format.number(pages)}</span>
                </span>
                {page < pages ? (
                  <Button asChild variant="outline" size="icon-sm" aria-label="Older events">
                    <Link href={auditLogHref({ ...filters, page: page + 1 }, pathname)} scroll={false}>
                      <ChevronRight />
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" size="icon-sm" aria-label="Older events" disabled>
                    <ChevronRight />
                  </Button>
                )}
              </span>
            )}
            <span className="ml-auto text-xs text-soft">
              Each node keeps its own log and chain. Times in <span className="num">{format.timeZone}</span>.
            </span>
          </div>
        }
      >
        {events.length > 0 ? (
          <div className="border-t border-line">
            <AuditEventsTable events={events} sinks={sinks} canHistory={canHistory} canApprovals={canApprovals} />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2.5 border-t border-line px-[18px] py-4 text-[13px] text-muted-foreground">
            {anyFilter || filters.range !== "all" ? (
              <>
                <span>No events match these filters.</span>
                <Button variant="secondary" size="sm" onClick={() => (anyFilter ? clearFilters() : navigate({ range: "all" }))}>
                  {anyFilter ? "Clear filters" : "Show all time"}
                </Button>
              </>
            ) : (
              <span>No audit events yet. Changes, sign-ins and checks appear here as they happen.</span>
            )}
          </div>
        )}
      </SectionCard>

      {providerLevel && sinks !== null && <StreamingStrip sinks={sinks} retentionDays={retentionDays} generatedAt={generatedAt} />}

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}
