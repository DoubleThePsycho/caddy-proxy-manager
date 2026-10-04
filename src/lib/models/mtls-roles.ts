import { appDb, nowIso, toIso } from "../db";
import { applyCaddyConfig } from "../caddy";
import { logAuditEvent } from "../audit";
import {
  mtlsRoles,
  mtlsCertificateRoles,
  issuedClientCertificates,
} from "../db/schema";
import { eq, inArray, count, and, isNull } from "drizzle-orm";
import { normalizeFingerprint } from "../caddy-mtls";
import { asc } from "@/src/lib/db/ops";

// ── Types ────────────────────────────────────────────────────────────

export type MtlsRole = {
  id: number;
  name: string;
  description: string | null;
  certificateCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MtlsRoleInput = {
  name: string;
  description?: string | null;
};

export type MtlsRoleWithCertificates = MtlsRole & {
  certificateIds: number[];
};

// ── Helpers ──────────────────────────────────────────────────────────

type RoleRow = typeof mtlsRoles.$inferSelect;

async function countCertsForRole(roleId: number): Promise<number> {
  const [row] = await appDb
    .select({ value: count() })
    .from(mtlsCertificateRoles)
    .where(eq(mtlsCertificateRoles.mtlsRoleId, roleId));
  return row?.value ?? 0;
}

function toMtlsRole(row: RoleRow, certCount: number): MtlsRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    certificateCount: certCount,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────

export async function listMtlsRoles(): Promise<MtlsRole[]> {
  const rows = await appDb.query.mtlsRoles.findMany({
    orderBy: (table) => [asc(table.name), asc(table.id)],
  });
  if (rows.length === 0) return [];

  const roleIds = rows.map((r) => r.id);
  const counts = await appDb
    .select({
      roleId: mtlsCertificateRoles.mtlsRoleId,
      cnt: count(),
    })
    .from(mtlsCertificateRoles)
    .where(inArray(mtlsCertificateRoles.mtlsRoleId, roleIds))
    .groupBy(mtlsCertificateRoles.mtlsRoleId);

  const countMap = new Map(counts.map((c) => [c.roleId, c.cnt]));
  return rows.map((r) => toMtlsRole(r, countMap.get(r.id) ?? 0));
}

export async function getMtlsRole(id: number): Promise<MtlsRoleWithCertificates | null> {
  const row = await appDb.query.mtlsRoles.findFirst({
    where: (table, { eq: cmpEq }) => cmpEq(table.id, id),
  });
  if (!row) return null;

  const assignments = await appDb
    .select({ certId: mtlsCertificateRoles.issuedClientCertificateId })
    .from(mtlsCertificateRoles)
    .where(eq(mtlsCertificateRoles.mtlsRoleId, id))
    .orderBy(asc(mtlsCertificateRoles.id));

  return {
    ...toMtlsRole(row, assignments.length),
    certificateIds: assignments.map((a) => a.certId),
  };
}

export async function createMtlsRole(
  input: MtlsRoleInput,
  actorUserId: number
): Promise<MtlsRole> {
  const now = nowIso();
  const [record] = await appDb
    .insert(mtlsRoles)
    .values({
      name: input.name.trim(),
      description: input.description ?? null,
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!record) throw new Error("Failed to create mTLS role");

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "mtls_role",
    entityId: record.id,
    summary: `Created mTLS role ${input.name}`,
  });

  return toMtlsRole(record, 0);
}

export async function updateMtlsRole(
  id: number,
  input: Partial<MtlsRoleInput>,
  actorUserId: number
): Promise<MtlsRole> {
  const existing = await appDb.query.mtlsRoles.findFirst({
    where: (table, { eq: cmpEq }) => cmpEq(table.id, id),
  });
  if (!existing) throw new Error("mTLS role not found");

  const now = nowIso();
  await appDb
    .update(mtlsRoles)
    .set({
      name: input.name?.trim() ?? existing.name,
      description: input.description !== undefined ? (input.description ?? null) : existing.description,
      updatedAt: now,
    })
    .where(eq(mtlsRoles.id, id));

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "mtls_role",
    entityId: id,
    summary: `Updated mTLS role ${input.name?.trim() ?? existing.name}`,
  });

  await applyCaddyConfig();
  const certCount = await countCertsForRole(id);
  const updated = await appDb.query.mtlsRoles.findFirst({
    where: (table, { eq: cmpEq }) => cmpEq(table.id, id),
  });
  return toMtlsRole(updated!, certCount);
}

/**
 * Deletes a role and its certificate assignments in one transaction. Foreign
 * keys are not enforced (SQLite runs with them off, PostgreSQL has none), so
 * the assignments are deleted here: left behind, they kept the role's
 * certificates trusted wherever the deleted role's id was still listed.
 */
export async function deleteMtlsRole(id: number, actorUserId: number): Promise<void> {
  const existing = await appDb.transaction(async (tx) => {
    const existing = await tx.query.mtlsRoles.findFirst({
      where: (table, { eq: cmpEq }) => cmpEq(table.id, id),
    });
    if (!existing) throw new Error("mTLS role not found");
    await tx.delete(mtlsCertificateRoles).where(eq(mtlsCertificateRoles.mtlsRoleId, id));
    await tx.delete(mtlsRoles).where(eq(mtlsRoles.id, id));
    return existing;
  });

  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "mtls_role",
    entityId: id,
    summary: `Deleted mTLS role ${existing.name}`,
  });

  await applyCaddyConfig();
}

// ── Certificate ↔ Role assignments ───────────────────────────────────

export async function assignRoleToCertificate(
  roleId: number,
  certId: number,
  actorUserId: number
): Promise<void> {
  const now = nowIso();
  // The role and the certificate are read in the transaction that inserts the
  // assignment, so neither can be deleted in between.
  const { role, cert } = await appDb.transaction(async (tx) => {
    const role = await tx.query.mtlsRoles.findFirst({
      where: (t, { eq: cmpEq }) => cmpEq(t.id, roleId),
    });
    if (!role) throw new Error("mTLS role not found");

    const cert = await tx.query.issuedClientCertificates.findFirst({
      where: (t, { eq: cmpEq }) => cmpEq(t.id, certId),
    });
    if (!cert) throw new Error("Issued client certificate not found");

    await tx
      .insert(mtlsCertificateRoles)
      .values({
        issuedClientCertificateId: certId,
        mtlsRoleId: roleId,
        createdAt: now,
      });
    return { role, cert };
  });

  await logAuditEvent({
    userId: actorUserId,
    action: "assign",
    entityType: "mtls_certificate_role",
    entityId: roleId,
    summary: `Assigned cert ${cert.commonName} to role ${role.name}`,
    data: { roleId, certId },
  });

  await applyCaddyConfig();
}

export async function removeRoleFromCertificate(
  roleId: number,
  certId: number,
  actorUserId: number
): Promise<void> {
  const role = await appDb.query.mtlsRoles.findFirst({
    where: (t, { eq: cmpEq }) => cmpEq(t.id, roleId),
  });
  if (!role) throw new Error("mTLS role not found");

  await appDb
    .delete(mtlsCertificateRoles)
    .where(
      and(
        eq(mtlsCertificateRoles.mtlsRoleId, roleId),
        eq(mtlsCertificateRoles.issuedClientCertificateId, certId)
      )
    );

  await logAuditEvent({
    userId: actorUserId,
    action: "unassign",
    entityType: "mtls_certificate_role",
    entityId: roleId,
    summary: `Removed cert from role ${role.name}`,
    data: { roleId, certId },
  });

  await applyCaddyConfig();
}

export async function getCertificateRoles(certId: number): Promise<MtlsRole[]> {
  const assignments = await appDb
    .select({ roleId: mtlsCertificateRoles.mtlsRoleId })
    .from(mtlsCertificateRoles)
    .where(eq(mtlsCertificateRoles.issuedClientCertificateId, certId));

  if (assignments.length === 0) return [];

  const roleIds = assignments.map((a) => a.roleId);
  const rows = await appDb
    .select()
    .from(mtlsRoles)
    .where(inArray(mtlsRoles.id, roleIds))
    .orderBy(asc(mtlsRoles.name), asc(mtlsRoles.id));

  return rows.map((r) => toMtlsRole(r, 0));
}

/**
 * Builds a map of roleId → Set<normalizedFingerprint> for all active (non-revoked) certs.
 * Used during Caddy config generation. Only roles that exist count: an
 * assignment left behind by a deleted role (foreign keys are not enforced)
 * must not keep its certificates trusted where the role's id is still listed.
 */
export async function buildRoleFingerprintMap(): Promise<Map<number, Set<string>>> {
  const rows = await appDb
    .select({
      roleId: mtlsCertificateRoles.mtlsRoleId,
      fingerprint: issuedClientCertificates.fingerprintSha256,
    })
    .from(mtlsCertificateRoles)
    .innerJoin(mtlsRoles, eq(mtlsCertificateRoles.mtlsRoleId, mtlsRoles.id))
    .innerJoin(
      issuedClientCertificates,
      eq(mtlsCertificateRoles.issuedClientCertificateId, issuedClientCertificates.id)
    )
    .where(isNull(issuedClientCertificates.revokedAt));

  const map = new Map<number, Set<string>>();
  for (const row of rows) {
    let set = map.get(row.roleId);
    if (!set) {
      set = new Set();
      map.set(row.roleId, set);
    }
    set.add(normalizeFingerprint(row.fingerprint));
  }
  return map;
}

/**
 * Builds a map of certId → normalizedFingerprint for all active (non-revoked) certs.
 * Used during Caddy config generation for direct cert overrides.
 */
export async function buildCertFingerprintMap(): Promise<Map<number, string>> {
  const rows = await appDb
    .select({
      id: issuedClientCertificates.id,
      fingerprint: issuedClientCertificates.fingerprintSha256,
    })
    .from(issuedClientCertificates)
    .where(isNull(issuedClientCertificates.revokedAt));

  const map = new Map<number, string>();
  for (const row of rows) {
    map.set(row.id, normalizeFingerprint(row.fingerprint));
  }
  return map;
}

/**
 * Builds a map of roleId → Set<certId> for all active (non-revoked) certs.
 * Used during Caddy config generation to resolve trusted_role_ids → cert IDs.
 * Only roles that exist count (see buildRoleFingerprintMap).
 */
export async function buildRoleCertIdMap(): Promise<Map<number, Set<number>>> {
  const rows = await appDb
    .select({
      roleId: mtlsCertificateRoles.mtlsRoleId,
      certId: mtlsCertificateRoles.issuedClientCertificateId,
    })
    .from(mtlsCertificateRoles)
    .innerJoin(mtlsRoles, eq(mtlsCertificateRoles.mtlsRoleId, mtlsRoles.id))
    .innerJoin(
      issuedClientCertificates,
      eq(mtlsCertificateRoles.issuedClientCertificateId, issuedClientCertificates.id)
    )
    .where(isNull(issuedClientCertificates.revokedAt));

  const map = new Map<number, Set<number>>();
  for (const row of rows) {
    let set = map.get(row.roleId);
    if (!set) {
      set = new Set();
      map.set(row.roleId, set);
    }
    set.add(row.certId);
  }
  return map;
}

// normalizeFingerprint is imported from caddy-mtls.ts (the canonical location)
// and re-exported for convenience.
export { normalizeFingerprint } from "../caddy-mtls";
