/**
 * Saved analytics views: a name for a range, filters, metric and grouping.
 * A view belongs to the user who saved it; shared, it is listed for every
 * user of the same organisation (or of the provider level) who can read
 * analytics. Only the owner changes a view; the owner, or an administrator
 * for a shared one, deletes it. A view outside what the caller can see
 * answers 404 exactly like a missing one.
 */
import { and, count, eq, isNull, or } from "drizzle-orm";
import { appDb, nowIso, toIso } from "../db";
import { analyticsSavedViews, users } from "../db/schema";
import { logAuditEvent } from "../audit";
import { ApiClientError, ApiValidationError } from "../api-errors";
import { tenantOf, type Access } from "../permissions";
import { parseFilters, type AnalyticsFilter } from "../analytics/filters";
import { GROUPINGS, parseGrouping, parseMetric, type Grouping, type Metric } from "../analytics/dimensions";
import { MAX_RANGE_SECONDS, isRangePreset, type RangePreset } from "../analytics/range";
import { asc, first } from "@/src/lib/db/ops";

export const MAX_VIEW_NAME_LENGTH = 100;
export const MAX_VIEWS_PER_USER = 100;

const NOT_FOUND = "Analytics view not found";

export type SavedViewRange = { preset: RangePreset } | { from: number; to: number };

export type AnalyticsSavedView = {
  id: number;
  name: string;
  shared: boolean;
  range: SavedViewRange;
  filters: AnalyticsFilter[];
  metric: Metric;
  /** Null: the metric's default grouping. */
  groupBy: Grouping | null;
  /** The caller saved this view (and may change it). */
  owned: boolean;
  /** Display name of the user who saved it (null when they have none). */
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = typeof analyticsSavedViews.$inferSelect;

function parseName(value: unknown): string {
  if (typeof value !== "string") throw new ApiValidationError("name is required");
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!name) throw new ApiValidationError("name is required");
  if (name.length > MAX_VIEW_NAME_LENGTH) throw new ApiValidationError(`name can be at most ${MAX_VIEW_NAME_LENGTH} characters`);
  return name;
}

function parseShared(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ApiValidationError("shared must be true or false");
  return value;
}

/** A preset name, {preset}, or {from, to} in Unix seconds. */
export function parseViewRange(value: unknown): SavedViewRange {
  if (isRangePreset(value)) return { preset: value };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.preset !== undefined) {
      if (!isRangePreset(v.preset)) throw new ApiValidationError("range.preset must be 1h, 24h, 7d or 30d");
      return { preset: v.preset };
    }
    const from = v.from;
    const to = v.to;
    if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && (from as number) >= 0 && (to as number) > (from as number)) {
      if ((to as number) - (from as number) > MAX_RANGE_SECONDS) throw new ApiValidationError("A custom range can cover at most 92 days");
      return { from: from as number, to: to as number };
    }
  }
  throw new ApiValidationError('range must be a preset ("24h" or {"preset":"24h"}) or {"from":<unix seconds>,"to":<unix seconds>}');
}

function parseGroupBy(value: unknown, metric: Metric): Grouping | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !(GROUPINGS as readonly string[]).includes(value)) {
    throw new ApiValidationError(`groupBy must be one of ${GROUPINGS.join(", ")}`);
  }
  return parseGrouping(value, metric);
}

function readJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toView(row: Row, access: Access, ownerName: string | null): AnalyticsSavedView {
  const metric = (() => {
    try {
      return parseMetric(row.metric);
    } catch {
      return "requests" as Metric;
    }
  })();
  let range: SavedViewRange;
  try {
    range = parseViewRange(readJson<unknown>(row.range, null));
  } catch {
    range = { preset: "24h" };
  }
  let filters: AnalyticsFilter[];
  try {
    filters = parseFilters(readJson<unknown>(row.filters, []));
  } catch {
    filters = [];
  }
  let groupBy: Grouping | null;
  try {
    groupBy = parseGroupBy(row.groupBy, metric);
  } catch {
    groupBy = null;
  }
  return {
    id: row.id,
    name: row.name,
    shared: Boolean(row.shared),
    range,
    filters,
    metric,
    groupBy,
    owned: row.userId === access.userId,
    ownerName,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

/** Rows of the caller's organisation (or of the provider level). */
function sameOrganization(access: Access) {
  const tenant = tenantOf(access);
  return tenant === null ? isNull(analyticsSavedViews.organizationId) : eq(analyticsSavedViews.organizationId, tenant);
}

/** Views the caller sees: their own, and the shared ones of their organisation. */
function visibleCondition(access: Access) {
  return or(
    eq(analyticsSavedViews.userId, access.userId),
    and(eq(analyticsSavedViews.shared, true), sameOrganization(access))
  );
}

async function ownerNames(rows: Row[]): Promise<Map<number, string | null>> {
  const ids = [...new Set(rows.map((row) => row.userId))];
  const names = new Map<number, string | null>();
  for (const id of ids) {
    const user = await first(appDb.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1));
    names.set(id, user?.name ?? null);
  }
  return names;
}

export async function listAnalyticsViews(access: Access): Promise<AnalyticsSavedView[]> {
  const rows = await appDb
    .select()
    .from(analyticsSavedViews)
    .where(visibleCondition(access))
    .orderBy(asc(analyticsSavedViews.name), asc(analyticsSavedViews.id));
  const names = await ownerNames(rows);
  return rows.map((row) => toView(row, access, names.get(row.userId) ?? null));
}

async function findVisibleRow(access: Access, id: number): Promise<Row> {
  const row = Number.isSafeInteger(id) && id > 0
    ? await first(appDb.select().from(analyticsSavedViews).where(and(eq(analyticsSavedViews.id, id), visibleCondition(access))).limit(1))
    : undefined;
  if (!row) throw new ApiClientError(NOT_FOUND, 404);
  return row;
}

export async function getAnalyticsView(access: Access, id: number): Promise<AnalyticsSavedView> {
  const row = await findVisibleRow(access, id);
  return toView(row, access, (await ownerNames([row])).get(row.userId) ?? null);
}

export async function createAnalyticsView(access: Access, input: Record<string, unknown>): Promise<AnalyticsSavedView> {
  const name = parseName(input.name);
  const shared = input.shared === undefined ? false : parseShared(input.shared);
  const range = parseViewRange(input.range ?? "24h");
  const metric = parseMetric(input.metric);
  const groupBy = parseGroupBy(input.groupBy, metric);
  const filters = parseFilters(input.filters ?? []);
  const now = nowIso();
  const organizationId = tenantOf(access);
  // The limit is counted in the transaction that inserts the view.
  const row = await appDb.transaction(async (tx) => {
    const owned = await first(tx.select({ value: count() }).from(analyticsSavedViews).where(eq(analyticsSavedViews.userId, access.userId)).limit(1));
    if ((owned?.value ?? 0) >= MAX_VIEWS_PER_USER) {
      throw new ApiClientError(`You can save at most ${MAX_VIEWS_PER_USER} analytics views`, 409);
    }
    return (await first(tx
      .insert(analyticsSavedViews)
      .values({
        userId: access.userId,
        organizationId,
        name,
        shared,
        range: JSON.stringify(range),
        filters: JSON.stringify(filters),
        metric,
        groupBy,
        createdAt: now,
        updatedAt: now,
      })
      .returning()))!;
  });
  await logAuditEvent({
    userId: access.userId,
    action: "create",
    entityType: "analytics_view",
    entityId: row.id,
    summary: `Saved analytics view "${name}"${shared ? " (shared)" : ""}`,
    data: { shared, metric, groupBy, range, filters: filters.length },
    organizationId,
  });
  return getAnalyticsView(access, row.id);
}

export async function updateAnalyticsView(access: Access, id: number, input: Record<string, unknown>): Promise<AnalyticsSavedView> {
  const row = await findVisibleRow(access, id);
  if (row.userId !== access.userId) throw new ApiClientError("Only the user who saved this view can change it", 403);
  const set: Partial<typeof analyticsSavedViews.$inferInsert> = {};
  if (input.name !== undefined) set.name = parseName(input.name);
  if (input.shared !== undefined) set.shared = parseShared(input.shared);
  if (input.range !== undefined) set.range = JSON.stringify(parseViewRange(input.range));
  const metric = input.metric !== undefined ? parseMetric(input.metric) : parseMetric(row.metric);
  if (input.metric !== undefined) set.metric = metric;
  if (input.groupBy !== undefined) set.groupBy = parseGroupBy(input.groupBy, metric);
  if (input.filters !== undefined) set.filters = JSON.stringify(parseFilters(input.filters));
  if (Object.keys(set).length === 0) throw new ApiValidationError("Nothing to change");
  set.updatedAt = nowIso();
  await appDb.update(analyticsSavedViews).set(set).where(eq(analyticsSavedViews.id, row.id));
  const changed = Object.keys(set).filter((key) => key !== "updatedAt");
  await logAuditEvent({
    userId: access.userId,
    action: "update",
    entityType: "analytics_view",
    entityId: row.id,
    summary: `Updated analytics view "${set.name ?? row.name}"`,
    data: { changed },
    organizationId: row.organizationId ?? null,
  });
  return getAnalyticsView(access, row.id);
}

export async function deleteAnalyticsView(access: Access, id: number): Promise<void> {
  const row = await findVisibleRow(access, id);
  const mayDelete = row.userId === access.userId || (access.isAdmin && row.shared);
  if (!mayDelete) throw new ApiClientError("Only the user who saved this view can delete it", 403);
  await appDb.delete(analyticsSavedViews).where(eq(analyticsSavedViews.id, row.id));
  await logAuditEvent({
    userId: access.userId,
    action: "delete",
    entityType: "analytics_view",
    entityId: row.id,
    summary: `Deleted analytics view "${row.name}"`,
    organizationId: row.organizationId ?? null,
  });
}
