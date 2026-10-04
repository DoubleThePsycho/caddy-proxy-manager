// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: storage of organisations and the reads the request path
 * makes (which organisation a user belongs to, whether it is enabled).
 * Everything takes a database reader (the database or a transaction on it),
 * so a check and the write it guards can share one transaction. Await every
 * check: a promise is always truthy.
 *
 * Nothing here looks at the license: isolation stays enforced, and
 * organisation users keep signing in, when the license lapses.
 */
import { count, eq } from "drizzle-orm";
import { appDb, toIso } from "@/src/lib/db";
import { organizations, users } from "@/src/lib/db/schema";
import { asc, first } from "@/src/lib/db/ops";
import type { DbExecutor } from "@/src/lib/db/types";

export const FEATURE = "multi_tenancy" as const;

/** The database or a transaction on it, for reads. */
export type TenantReader = Pick<DbExecutor, "select">;

/** The database or a transaction on it, for reads and writes. */
export type TenantWriter = Pick<DbExecutor, "select" | "insert" | "update" | "delete">;

export type Organization = {
  id: number;
  name: string;
  slug: string;
  enabled: boolean;
  maxProxyHosts: number | null;
  maxUsers: number | null;
  /** Upstream patterns the organisation's own users may proxy to (see upstreams.ts). */
  allowedUpstreams: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

type OrganizationRow = typeof organizations.$inferSelect;

function parseStoredPatterns(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function parseOrganizationRow(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    enabled: row.enabled,
    maxProxyHosts: row.maxProxyHosts ?? null,
    maxUsers: row.maxUsers ?? null,
    allowedUpstreams: parseStoredPatterns(row.allowedUpstreams),
    notes: row.notes ?? null,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

export async function readOrganization(reader: TenantReader, id: number): Promise<Organization | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = await first(reader.select().from(organizations).where(eq(organizations.id, id)).limit(1));
  return row ? parseOrganizationRow(row) : null;
}

export async function readOrganizationBySlug(reader: TenantReader, slug: string): Promise<Organization | null> {
  const row = await first(reader.select().from(organizations).where(eq(organizations.slug, slug)).limit(1));
  return row ? parseOrganizationRow(row) : null;
}

export async function listOrganizationRows(reader: TenantReader = appDb): Promise<Organization[]> {
  return (await reader.select().from(organizations).orderBy(asc(organizations.name), asc(organizations.id))).map(parseOrganizationRow);
}

export async function countOrganizations(reader: TenantReader = appDb): Promise<number> {
  return (await first(reader.select({ value: count() }).from(organizations).limit(1)))?.value ?? 0;
}

/** Id and name of every organisation, for pickers and labels. */
export async function organizationNames(reader: TenantReader = appDb): Promise<Map<number, string>> {
  return new Map(
    (await reader.select({ id: organizations.id, name: organizations.name }).from(organizations)).map((row) => [row.id, row.name])
  );
}

/**
 * The organisation user `userId` belongs to, and whether it lets them in, or
 * null for a provider-level user (or one that does not exist). An
 * organisation that no longer exists counts as disabled, so its users stay
 * confined to it and cannot sign in.
 */
export async function readUserTenant(reader: TenantReader, userId: number): Promise<{ organizationId: number; enabled: boolean } | null> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  const row = await first(reader
    .select({ organizationId: users.organizationId, enabled: organizations.enabled })
    .from(users)
    .leftJoin(organizations, eq(organizations.id, users.organizationId))
    .where(eq(users.id, userId))
    .limit(1));
  if (!row || row.organizationId === null || row.organizationId === undefined) return null;
  return { organizationId: row.organizationId, enabled: row.enabled === true };
}

/** Whether organisation `organizationId` exists and is enabled. */
export async function isOrganizationEnabled(reader: TenantReader, organizationId: number): Promise<boolean> {
  const row = await first(reader.select({ enabled: organizations.enabled }).from(organizations).where(eq(organizations.id, organizationId)).limit(1));
  return row?.enabled === true;
}

/** The organisation of user `userId`, or null for the provider level. */
export async function userOrganizationId(reader: TenantReader, userId: number): Promise<number | null> {
  return (await readUserTenant(reader, userId))?.organizationId ?? null;
}

/**
 * True when user `userId` belongs to an organisation that is disabled (or
 * gone): they get no session, their API tokens and forward-auth sessions stop
 * working. Provider-level users are never blocked here.
 */
export async function isUserOrganizationBlocked(reader: TenantReader, userId: number): Promise<boolean> {
  const tenant = await readUserTenant(reader, userId);
  return tenant !== null && !tenant.enabled;
}
