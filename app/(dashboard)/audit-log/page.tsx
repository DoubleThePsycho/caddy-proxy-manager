import AuditLogClient from "./AuditLogClient";
import {
  countAuditEventsMatching,
  listAuditFacets,
  parseAuditFilter,
  queryAuditEvents,
  type AuditEventRecord,
  type AuditFilter,
} from "@/src/lib/models/audit";
import { requirePermission } from "@/src/lib/auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { can, tenantOf } from "@/src/lib/permissions";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { getAuditChainStatus } from "@/ee/audit/chain-status";
import { listAuditSinkSummaries } from "@/ee/audit/sink-summary";
import { getAuditRetention } from "@/ee/audit/retention";
import { dashboardOrganizationFilter } from "@/ee/multi-tenancy/view";
import { parsePageParam } from "@/src/lib/pagination";
import {
  EMPTY_FILTERS,
  RANGE_MS,
  hasNarrowingFilters,
  isAuditRange,
  type AuditEventRow,
  type AuditFilters,
} from "@/src/lib/audit-log-view";

export const metadata = { title: "Audit log" };

const PER_PAGE = 50;

type SearchParams = Record<string, string | string[] | undefined>;

interface PageProps {
  searchParams: Promise<SearchParams>;
}

function first(params: SearchParams, key: string): string {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/** The URL filters as the page shows them. */
function readFilters(params: SearchParams): AuditFilters {
  const range = first(params, "range");
  return {
    ...EMPTY_FILTERS,
    q: (first(params, "q") || first(params, "search")).slice(0, 200),
    actor: first(params, "actor"),
    action: first(params, "action"),
    entityType: first(params, "entityType"),
    entityId: first(params, "entityId"),
    range: isAuditRange(range) ? range : "all",
    from: first(params, "from"),
    to: first(params, "to"),
    page: parsePageParam(params.page),
  };
}

type ParsedFilter = Omit<AuditFilter, "organizationId">;

/**
 * Each filter through the REST API's parser on its own, so an invalid one
 * is named and left out while the others still apply.
 */
function parseFilters(filters: AuditFilters, now: number): { filter: ParsedFilter; invalid: string[] } {
  const filter: ParsedFilter = {};
  const invalid: string[] = [];
  const apply = (entries: Record<string, string>) => {
    const params = new URLSearchParams(Object.entries(entries).filter(([, value]) => value !== ""));
    if ([...params.keys()].length === 0) return;
    try {
      for (const [key, value] of Object.entries(parseAuditFilter(params))) {
        if (value !== undefined) (filter as Record<string, unknown>)[key] = value;
      }
    } catch (error) {
      if (!(error instanceof ApiValidationError)) throw error;
      invalid.push(error.message);
    }
  };
  apply({ search: filters.q });
  apply({ actor: filters.actor });
  apply({ action: filters.action });
  apply({ entityType: filters.entityType });
  apply({ entityId: filters.entityId });
  // An explicit period wins over the range buttons.
  const from = filters.from || (filters.range !== "all" ? new Date(now - RANGE_MS[filters.range]).toISOString() : "");
  apply({ from, to: filters.to });
  return { filter, invalid };
}

function toRow(record: AuditEventRecord, tenantView: boolean): AuditEventRow {
  const actor: AuditEventRow["actor"] = record.user
    ? { kind: "user", name: record.user.name?.trim() || record.user.email || `User #${record.user.id}`, email: record.user.email }
    : record.userId === null
      ? { kind: "system", name: "System", email: null }
      : tenantView
        ? { kind: "provider", name: "Provider", email: null }
        : { kind: "deleted", name: `Deleted user #${record.userId}`, email: null };
  return {
    id: record.id,
    createdAt: record.createdAt,
    userId: record.user ? record.userId : null,
    actor,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    summary: record.summary,
    hash: record.hash,
    prevHash: record.prevHash,
    configChange: record.configChange,
  };
}

export default async function AuditLogPage({ searchParams }: PageProps) {
  const { access } = await requirePermission("audit_log:read");
  // An organisation user reads their organisation's audit log only; a
  // provider-level user the organisation they picked (ee/multi-tenancy).
  const organizationId = await dashboardOrganizationFilter(access);
  const providerLevel = tenantOf(access) === null;
  // The hash chain and the sinks span every organisation: provider level only.
  const canStreaming = providerLevel && can(access, "audit_streaming:read");
  const now = Date.now();
  const requested = readFilters(await searchParams);
  const { filter, invalid } = parseFilters(requested, now);
  const scoped = { ...filter, organizationId };

  // A page past the last one shows the last.
  const total = await countAuditEventsMatching(scoped);
  const filters = { ...requested, page: Math.min(requested.page, Math.max(1, Math.ceil(total / PER_PAGE))) };

  const [records, inRange, facets, licensed, chain, sinks, retention] = await Promise.all([
    queryAuditEvents(scoped, { limit: PER_PAGE, offset: (filters.page - 1) * PER_PAGE }),
    hasNarrowingFilters(filters) ? countAuditEventsMatching({ from: filter.from, to: filter.to, organizationId }) : Promise.resolve(null),
    listAuditFacets(organizationId),
    isFeatureConfigurable("audit_streaming"),
    providerLevel ? getAuditChainStatus() : Promise.resolve(null),
    canStreaming ? listAuditSinkSummaries() : Promise.resolve(null),
    canStreaming ? getAuditRetention() : Promise.resolve(null),
  ]);

  // Viewing one organisation: users of other organisations (the provider) are not named.
  const tenantView = typeof organizationId === "number";
  return (
    <AuditLogClient
      events={records.map((record) => toRow(record, tenantView))}
      total={total}
      totalInRange={inRange}
      page={filters.page}
      perPage={PER_PAGE}
      filters={filters}
      invalidFilters={invalid}
      facets={{
        actors: facets.actors.map((actor) => ({
          value: actor.id === null ? "system" : String(actor.id),
          label: actor.id === null ? "System" : actor.name?.trim() || actor.email || `User #${actor.id}`,
          events: actor.events,
        })),
        actions: facets.actions,
        entityTypes: facets.entityTypes,
      }}
      licensed={licensed}
      providerLevel={providerLevel}
      chain={chain}
      sinks={sinks}
      retentionDays={retention ? retention.days : null}
      canHistory={can(access, "config_history:read")}
      canApprovals={can(access, "approvals:read")}
      generatedAt={new Date(now).toISOString()}
    />
  );
}
