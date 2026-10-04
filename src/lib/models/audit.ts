import { appDb, toIso } from "../db";
import { auditEvents, users } from "../db/schema";
import { and, eq, gte, isNull, lte, or, count, type SQL } from "drizzle-orm";
import { insertAuditEvent } from "../audit-chain";
import { ApiValidationError } from "../api-errors";
import { organizationCondition, type OrganizationFilter } from "@/ee/multi-tenancy/scope";
import { asc, containsText, desc } from "@/src/lib/db/ops";

export type AuditEvent = {
  id: number;
  userId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  createdAt: string;
};

function auditWhere(search: string | undefined, organizationId: OrganizationFilter): SQL | undefined {
  // The search text is matched literally (containsText escapes LIKE's wildcards).
  const searchCondition = search
    ? or(
        containsText(auditEvents.summary, search),
        containsText(auditEvents.action, search),
        containsText(auditEvents.entityType, search)
      )
    : undefined;
  return and(searchCondition, organizationCondition(auditEvents.organizationId, organizationId));
}

/**
 * `organizationId` limits the events to one organisation's audit log (or the
 * provider level's, with null); see ee/multi-tenancy/scope.ts.
 */
export async function countAuditEvents(search?: string, organizationId?: OrganizationFilter): Promise<number> {
  const [row] = await appDb.select({ value: count() }).from(auditEvents).where(auditWhere(search, organizationId));
  return row?.value ?? 0;
}

export async function listAuditEvents(
  limit = 100,
  offset = 0,
  search?: string,
  organizationId?: OrganizationFilter
): Promise<AuditEvent[]> {
  const where = auditWhere(search, organizationId);
  const events = await appDb
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit)
    .offset(offset);

  return events.map((event) => ({
    id: event.id,
    userId: event.userId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary,
    createdAt: toIso(event.createdAt)!,
  }));
}

export async function createAuditEvent(data: {
  userId: number | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  summary?: string | null;
  data?: string | null;
}): Promise<void> {
  await insertAuditEvent({
    userId: data.userId,
    action: data.action,
    entityType: data.entityType,
    entityId: data.entityId ?? null,
    summary: data.summary ?? null,
    data: data.data ?? null,
  });
}

// ── Filtered listing (REST API) ─────────────────────────────────────────

/**
 * Server-side filters of the audit log. Every one is optional and they
 * combine with AND. `actor` is a user id, or "system" for events no user
 * recorded. Text is matched literally (LIKE metacharacters escaped) against
 * the summary, the action and the entity type.
 */
export type AuditFilter = {
  search?: string;
  actor?: number | "system";
  action?: string;
  entityType?: string;
  entityId?: number;
  /** createdAt bounds, inclusive, ISO 8601. */
  from?: string;
  to?: string;
  organizationId?: OrganizationFilter;
};

/** An event as listed by the REST API: who acted, the hash chain fields, and its configuration change, if any. */
export type AuditEventRecord = AuditEvent & {
  user: { id: number; name: string | null; email: string | null } | null;
  hash: string | null;
  prevHash: string | null;
  /** Configuration history versions around a configuration change (ee/config-history/links.ts). */
  configChange: { beforeId: number | null; afterId: number | null; changeRequestId: number | null; pending: boolean } | null;
};

const MAX_FILTER_TEXT = 200;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function readText(value: string | null, field: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (text.length > MAX_FILTER_TEXT) throw new ApiValidationError(`${field} must be at most ${MAX_FILTER_TEXT} characters`);
  return text;
}

function readInstant(value: string | null, field: string, endOfDay: boolean): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const isDate = DATE_ONLY.test(text);
  const ms = Date.parse(isDate ? `${text}T00:00:00.000Z` : text);
  if (text.length > 40 || Number.isNaN(ms) || !(isDate || /^\d{4}-\d{2}-\d{2}T/.test(text))) {
    throw new ApiValidationError(`${field} must be an ISO 8601 date or date-time`);
  }
  // A bare date as the upper bound includes the whole day.
  return new Date(isDate && endOfDay ? ms + DAY_MS - 1 : ms).toISOString();
}

/** Reads the filters of GET /api/v1/audit-log (organisation scoping is the caller's). */
export function parseAuditFilter(params: URLSearchParams): Omit<AuditFilter, "organizationId"> {
  const filter: Omit<AuditFilter, "organizationId"> = {};
  filter.search = readText(params.get("search") ?? params.get("q"), "search");
  const actor = params.get("actor")?.trim();
  if (actor) {
    if (actor === "system") filter.actor = "system";
    else if (/^[1-9]\d{0,15}$/.test(actor)) filter.actor = Number(actor);
    else throw new ApiValidationError('actor must be a user id or "system"');
  }
  const action = readText(params.get("action"), "action");
  if (action) {
    if (!/^[a-z0-9_.:-]+$/i.test(action)) throw new ApiValidationError("action must be an action name");
    filter.action = action;
  }
  const entityType = readText(params.get("entityType") ?? params.get("entity_type"), "entityType");
  if (entityType) {
    if (!/^[a-z0-9_]+$/i.test(entityType)) throw new ApiValidationError("entityType must be an entity type");
    filter.entityType = entityType;
  }
  const entityId = (params.get("entityId") ?? params.get("entity_id"))?.trim();
  if (entityId) {
    if (!/^\d{1,15}$/.test(entityId)) throw new ApiValidationError("entityId must be a whole number");
    filter.entityId = Number(entityId);
  }
  filter.from = readInstant(params.get("from"), "from", false);
  filter.to = readInstant(params.get("to"), "to", true);
  if (filter.from && filter.to && filter.from > filter.to) throw new ApiValidationError("from must not be after to");
  return filter;
}

function filterWhere(filter: AuditFilter): SQL | undefined {
  const conditions: (SQL | undefined)[] = [auditWhere(filter.search, filter.organizationId)];
  if (filter.actor === "system") conditions.push(isNull(auditEvents.userId));
  else if (filter.actor !== undefined) conditions.push(eq(auditEvents.userId, filter.actor));
  if (filter.action) conditions.push(eq(auditEvents.action, filter.action));
  if (filter.entityType) conditions.push(eq(auditEvents.entityType, filter.entityType));
  if (filter.entityId !== undefined) conditions.push(eq(auditEvents.entityId, filter.entityId));
  if (filter.from) conditions.push(gte(auditEvents.createdAt, filter.from));
  if (filter.to) conditions.push(lte(auditEvents.createdAt, filter.to));
  return and(...conditions);
}

const RECORD_COLUMNS = {
  id: auditEvents.id,
  userId: auditEvents.userId,
  action: auditEvents.action,
  entityType: auditEvents.entityType,
  entityId: auditEvents.entityId,
  summary: auditEvents.summary,
  createdAt: auditEvents.createdAt,
  hash: auditEvents.hash,
  prevHash: auditEvents.prevHash,
  configBeforeId: auditEvents.configBeforeId,
  configAfterId: auditEvents.configAfterId,
  changeRequestId: auditEvents.changeRequestId,
  organizationId: auditEvents.organizationId,
  userName: users.name,
  userEmail: users.email,
  userOrganizationId: users.organizationId,
};

type RecordRow = {
  id: number;
  userId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  createdAt: string;
  hash: string | null;
  prevHash: string | null;
  configBeforeId: number | null;
  configAfterId: number | null;
  changeRequestId: number | null;
  organizationId: number | null;
  userName: string | null;
  userEmail: string | null;
  userOrganizationId: number | null;
};

/**
 * `tenant`: an organisation's audit log names only its own users; who
 * else acted (the provider) is left out, as on the dashboard.
 */
function toRecord(row: RecordRow, tenant: number | null): AuditEventRecord {
  const named = row.userId !== null && (tenant === null || row.userOrganizationId === tenant);
  return {
    id: row.id,
    userId: row.userId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    summary: row.summary,
    createdAt: toIso(row.createdAt)!,
    user: named ? { id: row.userId!, name: row.userName, email: row.userEmail } : null,
    hash: row.hash,
    prevHash: row.prevHash,
    configChange:
      row.configBeforeId !== null || row.changeRequestId !== null
        ? { beforeId: row.configBeforeId, afterId: row.configAfterId, changeRequestId: row.changeRequestId, pending: row.configBeforeId !== null && row.configAfterId === null }
        : null,
  };
}

function tenantOfFilter(filter: OrganizationFilter): number | null {
  return typeof filter === "number" ? filter : null;
}

export async function queryAuditEvents(filter: AuditFilter, page: { limit: number; offset: number }): Promise<AuditEventRecord[]> {
  const rows = await appDb
    .select(RECORD_COLUMNS)
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.userId))
    .where(filterWhere(filter))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(page.limit)
    .offset(page.offset);
  const tenant = tenantOfFilter(filter.organizationId);
  return rows.map((row) => toRecord(row, tenant));
}

export async function countAuditEventsMatching(filter: AuditFilter): Promise<number> {
  const [row] = await appDb.select({ value: count() }).from(auditEvents).where(filterWhere(filter));
  return row?.value ?? 0;
}

/** One event (null when it does not exist or is outside `organizationId`). */
export async function getAuditEventRecord(id: number, organizationId?: OrganizationFilter): Promise<(AuditEventRecord & { data: unknown; configBeforeId: number | null; configAfterId: number | null }) | null> {
  const [row] = await appDb
    .select({ ...RECORD_COLUMNS, data: auditEvents.data })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.userId))
    .where(and(eq(auditEvents.id, id), organizationCondition(auditEvents.organizationId, organizationId)))
    .limit(1);
  if (!row) return null;
  let data: unknown = null;
  if (row.data) {
    try {
      data = JSON.parse(row.data);
    } catch {
      data = row.data;
    }
  }
  return { ...toRecord(row, tenantOfFilter(organizationId)), data, configBeforeId: row.configBeforeId, configAfterId: row.configAfterId };
}

/** Values the filters can take: actors, actions and entity types that occur (at most 200 each). */
export async function listAuditFacets(organizationId?: OrganizationFilter): Promise<{
  actors: { id: number | null; name: string | null; email: string | null; events: number }[];
  actions: string[];
  entityTypes: string[];
}> {
  const where = organizationCondition(auditEvents.organizationId, organizationId);
  const tenant = tenantOfFilter(organizationId);
  const [actorRows, actionRows, entityRows] = await Promise.all([
    appDb
      .select({ id: auditEvents.userId, name: users.name, email: users.email, userOrganizationId: users.organizationId, events: count() })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.userId))
      .where(where)
      // Every selected column that is not aggregated (PostgreSQL requires it);
      // the user columns follow from userId, so the groups are the same.
      .groupBy(auditEvents.userId, users.name, users.email, users.organizationId)
      .orderBy(desc(count()), asc(auditEvents.userId))
      .limit(200),
    appDb.selectDistinct({ action: auditEvents.action }).from(auditEvents).where(where).orderBy(asc(auditEvents.action)).limit(200),
    appDb.selectDistinct({ entityType: auditEvents.entityType }).from(auditEvents).where(where).orderBy(asc(auditEvents.entityType)).limit(200),
  ]);
  return {
    actors: actorRows
      .filter((row) => row.id === null || tenant === null || row.userOrganizationId === tenant)
      .map((row) => ({ id: row.id, name: row.id === null ? null : row.name, email: row.id === null ? null : row.email, events: row.events })),
    actions: actionRows.map((row) => row.action),
    entityTypes: entityRows.map((row) => row.entityType),
  };
}
