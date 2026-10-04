// SPDX-License-Identifier: Elastic-2.0
/**
 * Building blocks of the report builders: tables, findings, audit-event
 * helpers and the read-only analytics dependency. Builders read the database
 * and return data only; nothing here writes.
 */
import { and, count, eq, gte, inArray, lte } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { auditEvents, users } from "@/src/lib/db/schema";
import { analyticsAvailable, defaultAnalyticsQuery, type AnalyticsQuery } from "@/ee/ai/clickhouse";
import type { Period } from "../http";
import type {
  FindingCounts,
  FindingSeverity,
  ReportCell,
  ReportColumn,
  ReportFinding,
  ReportSection,
  ReportSummaryItem,
  ScheduleQuestion,
} from "../types";
import { asc, first } from "@/src/lib/db/ops";

export const DAY_MS = 24 * 60 * 60 * 1000;

export type AnalyticsDependencies = {
  analyticsEnabled: () => boolean;
  query: AnalyticsQuery;
};

export const defaultAnalytics: AnalyticsDependencies = {
  analyticsEnabled: analyticsAvailable,
  query: defaultAnalyticsQuery,
};

export type BuildContext = {
  period: Period;
  now: Date;
  analytics: AnalyticsDependencies;
  /** The "Traffic questions" report: the schedule's saved questions. */
  questions?: readonly ScheduleQuestion[];
};

export type BuiltReport = {
  summary: ReportSummaryItem[];
  findings: ReportFinding[];
  sections: ReportSection[];
  notes: string[];
};

export type ReportBuilder = (context: BuildContext) => Promise<BuiltReport>;

export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Whole days from `earlier` to `later` (negative when `earlier` is later). */
export function daysBetween(earlier: Date | string, later: Date): number {
  const start = earlier instanceof Date ? earlier.getTime() : Date.parse(earlier);
  return Math.floor((later.getTime() - start) / DAY_MS);
}

export function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseStringArray(value: string | null | undefined): string[] {
  return parseJsonArray(value).filter((item): item is string => typeof item === "string");
}

/** A printable, single-line, bounded string (values in reports can come from users and requests). */
export function clean(value: unknown, max = 300): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\p{Cc}+/gu, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function columns(definitions: [string, string][]): ReportColumn[] {
  return definitions.map(([key, label]) => ({ key, label }));
}

/** A table; with `limit`, rows beyond it are left out and the section says so. */
export function section(
  key: string,
  title: string,
  description: string | null,
  cols: ReportColumn[],
  rows: Record<string, ReportCell>[],
  options: { limit?: number; total?: number } = {}
): ReportSection {
  const total = options.total ?? rows.length;
  const shown = options.limit !== undefined ? rows.slice(0, options.limit) : rows;
  return {
    key,
    title,
    description,
    columns: cols,
    rows: shown,
    truncated: shown.length < total ? { shown: shown.length, total } : null,
  };
}

/** A two-column table of settings or results. */
export function keyValueSection(key: string, title: string, description: string | null, items: [string, ReportCell][]): ReportSection {
  return section(
    key,
    title,
    description,
    columns([["item", "Item"], ["value", "Value"]]),
    items.map(([item, value]) => ({ item, value }))
  );
}

export function summaryItem(key: string, label: string, value: ReportSummaryItem["value"]): ReportSummaryItem {
  return { key, label, value };
}

export function finding(severity: FindingSeverity, code: string, subject: string, message: string): ReportFinding {
  return { severity, code, subject, message };
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export function sortFindings(findings: ReportFinding[]): ReportFinding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code) || a.subject.localeCompare(b.subject)
  );
}

export function countFindings(findings: ReportFinding[]): FindingCounts {
  const counts: FindingCounts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const item of findings) counts[item.severity] += 1;
  return counts;
}

export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/** "Name <email>" style label of a dashboard user. */
export function userLabel(user: { name: string | null; email: string | null; username?: string | null } | null | undefined, id?: number | null): string {
  if (!user) return id ? `Deleted user #${id}` : "System";
  const name = clean(user.name ?? user.username ?? "", 120);
  const email = clean(user.email ?? "", 200);
  if (name && email) return `${name} <${email}>`;
  return name || email || (id ? `User #${id}` : "System");
}

export type AuditRow = {
  id: number;
  createdAt: string;
  userId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  hash: string | null;
  userName: string | null;
  userEmail: string | null;
  username: string | null;
};

function periodCondition(period: Period, entityTypes?: readonly string[]) {
  return and(
    gte(auditEvents.createdAt, period.from.toISOString()),
    lte(auditEvents.createdAt, period.to.toISOString()),
    entityTypes ? inArray(auditEvents.entityType, [...entityTypes]) : undefined
  );
}

/** Audit events of the period (oldest first), optionally of some entity types, with the actor's name. */
export async function auditEventsInPeriod(period: Period, options: { entityTypes?: readonly string[]; limit: number }): Promise<{ rows: AuditRow[]; total: number }> {
  const where = periodCondition(period, options.entityTypes);
  const rows = await appDb
    .select({
      id: auditEvents.id,
      createdAt: auditEvents.createdAt,
      userId: auditEvents.userId,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      summary: auditEvents.summary,
      hash: auditEvents.hash,
      userName: users.name,
      userEmail: users.email,
      username: users.username,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.userId))
    .where(where)
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
    .limit(options.limit);
  const total = (await first(appDb.select({ value: count() }).from(auditEvents).where(where).limit(1)))?.value ?? 0;
  return { rows, total };
}

export function auditActor(row: Pick<AuditRow, "userId" | "userName" | "userEmail" | "username">): string {
  // Deleting a user clears userId on its events (src/lib/models/user.ts).
  if (row.userId === null) return "System or deleted account";
  if (row.userEmail === null && row.userName === null) return `Deleted user #${row.userId}`;
  return userLabel({ name: row.userName, email: row.userEmail, username: row.username }, row.userId);
}

/** The table of audit events used by several reports. */
export function auditEventSection(
  key: string,
  title: string,
  description: string,
  events: { rows: AuditRow[]; total: number },
  limit: number
): ReportSection {
  return section(
    key,
    title,
    description,
    columns([
      ["id", "Event"],
      ["at", "Time (UTC)"],
      ["actor", "Actor"],
      ["action", "Action"],
      ["entityType", "Entity"],
      ["entityId", "Entity id"],
      ["summary", "Summary"],
    ]),
    events.rows.map((row) => ({
      id: row.id,
      at: iso(row.createdAt),
      actor: auditActor(row),
      action: clean(row.action, 80),
      entityType: clean(row.entityType, 80),
      entityId: row.entityId,
      summary: clean(row.summary ?? "", 500),
    })),
    { limit, total: events.total }
  );
}
