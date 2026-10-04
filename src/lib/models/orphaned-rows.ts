/**
 * Rows left behind by deleted rows. The schema declares foreign keys with
 * onDelete rules, but SQLite runs with foreign keys off and PostgreSQL has
 * none (src/lib/db/README.md), so the models delete dependent rows
 * themselves. Older releases did not always do so: deleting a group left its
 * memberships and forward-auth grants, deleting a proxy host its mTLS path
 * rules, forward-auth grants and sign-in state, deleting an mTLS role its
 * certificate assignments, and deleting an access list (until the access
 * lists rework) its members and rules.
 *
 * Such rows are harmless only while their parent's id is never handed out
 * again. Ids can be handed out again (a copy to PostgreSQL sets each identity
 * past the highest id left, a table rebuild resets SQLite's counter), and the
 * new row would inherit them: a new group its members and host grants, a new
 * host another host's grants. The certificate assignments of a deleted mTLS
 * role are worse: the Caddy configuration kept trusting them wherever the
 * role's id was still listed (fixed in mtls-roles.ts as well).
 *
 * deleteOrphanedRows() removes them at start-up (src/lib/db/startup.ts). It is
 * idempotent and runs on every start. Users are not handled here: their
 * references are cleared by deleteOrphanedUserReferences (models/user.ts),
 * which ensureAdminUser runs.
 *
 * It never changes what is served: dependants of a deleted access list that a
 * proxy host still points at are kept, because the Caddy configuration still
 * applies them to that host (its members' basic auth and its rules), and
 * dropping them would open the host. They are reported instead, as are
 * hosts that point at a deleted certificate.
 */
import { and, getTableColumns, inArray, isNotNull, notInArray, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { referencesTo, type TableReference } from "../db/references";
import {
  accessLists,
  alertRules,
  caCertificates,
  certificates,
  forwardAuthSessions,
  groups,
  issuedClientCertificates,
  mtlsRoles,
  proxyHosts,
} from "../db/schema";
import type { AppDb, AppTx } from "../db/types";

/**
 * Every table other than users that a declared foreign key references, with
 * its id column, in the order their orphans are removed: a parent's
 * dependants are deleted before the dependants' own dependants are looked
 * at, so chains (CA → issued certificate → role assignment, proxy host →
 * forward-auth session → exchange code) are removed in one run.
 */
export const ORPHAN_PARENTS = [
  { name: "ca_certificates", id: caCertificates.id },
  { name: "issued_client_certificates", id: issuedClientCertificates.id },
  { name: "mtls_roles", id: mtlsRoles.id },
  { name: "certificates", id: certificates.id },
  { name: "access_lists", id: accessLists.id },
  { name: "proxy_hosts", id: proxyHosts.id },
  { name: "forward_auth_sessions", id: forwardAuthSessions.id },
  { name: "groups", id: groups.id },
  { name: "alert_rules", id: alertRules.id },
] as const;

export type OrphanReport = {
  /** Rows deleted, per "table.column" that pointed at a deleted row. */
  deleted: { reference: string; rows: number }[];
  /**
   * Rows that point at a deleted row through a "set null" reference (a proxy
   * host's certificate or access list), left as they are.
   */
  dangling: { reference: string; rowIds: number[]; parentIds: number[] }[];
  /** Dependants of those deleted rows, kept because the dangling rows still use them. */
  kept: { reference: string; parentIds: number[] }[];
};

function referenceName(reference: TableReference): string {
  return `${reference.tableName}.${reference.columnName}`;
}

/** `column` names a row that `parentId`'s table does not have. */
function pointsAtMissing(tx: AppTx, column: SQLiteColumn, parentId: SQLiteColumn): SQL {
  const parentTable = parentId.table as unknown as SQLiteTable;
  return and(isNotNull(column), notInArray(column, tx.select({ id: parentId }).from(parentTable)))!;
}

function sortedIds(values: Iterable<unknown>): number[] {
  return [...new Set([...values].map(Number))].sort((a, b) => a - b);
}

/**
 * Deletes the rows whose parent row is gone, in one transaction, and returns
 * what it did and what it left. See the module comment.
 */
export async function deleteOrphanedRows(db: AppDb): Promise<OrphanReport> {
  const report: OrphanReport = { deleted: [], dangling: [], kept: [] };
  await db.transaction(async (tx) => {
    for (const parent of ORPHAN_PARENTS) {
      const references = referencesTo(parent.name);
      const parentId = parent.id as unknown as SQLiteColumn;

      // Rows that are kept and still point at a deleted parent: that
      // parent's other dependants stay for them.
      const keptIds = new Set<number>();
      for (const reference of references) {
        if (reference.onDelete !== "set null") continue;
        const rowId = (getTableColumns(reference.table) as Record<string, SQLiteColumn>).id;
        const rows = await tx
          .select({ rowId, parentId: reference.column })
          .from(reference.table)
          .where(pointsAtMissing(tx, reference.column, parentId));
        if (rows.length === 0) continue;
        const parentIds = sortedIds(rows.map((row) => row.parentId));
        for (const id of parentIds) keptIds.add(id);
        report.dangling.push({ reference: referenceName(reference), rowIds: sortedIds(rows.map((row) => row.rowId)), parentIds });
      }

      for (const reference of references) {
        if (reference.onDelete !== "cascade") continue;
        const missing = pointsAtMissing(tx, reference.column, parentId);
        const kept = keptIds.size > 0
          ? await tx.selectDistinct({ parentId: reference.column }).from(reference.table).where(and(missing, inArray(reference.column, [...keptIds])))
          : [];
        if (kept.length > 0) report.kept.push({ reference: referenceName(reference), parentIds: sortedIds(kept.map((row) => row.parentId)) });
        const deleted = await tx
          .delete(reference.table)
          .where(keptIds.size > 0 ? and(missing, notInArray(reference.column, [...keptIds])) : missing)
          .returning({ parentId: reference.column });
        if (deleted.length > 0) report.deleted.push({ reference: referenceName(reference), rows: deleted.length });
      }
    }
  });
  return report;
}

/** deleteOrphanedRows with what it did logged; never throws (start-up goes on). */
export async function clearOrphanedRowsAtStartup(db: AppDb): Promise<void> {
  try {
    const report = await deleteOrphanedRows(db);
    for (const { reference, rows } of report.deleted) {
      console.log(`Removed ${rows} row(s) of ${reference} that pointed at deleted rows`);
    }
    for (const { reference, rowIds, parentIds } of report.dangling) {
      console.warn(`${reference} of row(s) ${rowIds.join(", ")} names deleted row(s) ${parentIds.join(", ")}; left as it is`);
    }
    for (const { reference, parentIds } of report.kept) {
      console.warn(`Kept the ${reference} rows of deleted row(s) ${parentIds.join(", ")}: rows in use still name them`);
    }
  } catch (error) {
    console.warn("Could not remove rows left by deleted rows:", error instanceof Error ? error.message : error);
  }
}
