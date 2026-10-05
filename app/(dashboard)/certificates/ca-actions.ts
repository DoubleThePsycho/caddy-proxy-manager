"use server";

import { revalidatePath } from "next/cache";
import { BRAND_NAME } from "@/src/lib/brand";
import { requirePermission } from "@/src/lib/auth";
import { assertUnscopedCertificates } from "@/src/lib/access-scope";
import {
  CaPrivateKeyUnavailableError,
  createCaCertificate,
  deleteCaCertificate,
  getCaCertificate,
  getCaCertificatePrivateKey,
  updateCaCertificate
} from "@/src/lib/models/ca-certificates";
import {
  createIssuedClientCertificate,
  getIssuedClientCertificate,
  revokeIssuedClientCertificate,
  type IssuedClientCertificate
} from "@/src/lib/models/issued-client-certificates";
import { runAsChangeBatch } from "@/src/lib/change-batch";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { logAuditEvent } from "@/src/lib/audit";
import { X509Certificate } from "node:crypto";
import forge from "node-forge";

function validatePem(pem: string): void {
  try {
    new X509Certificate(pem);
  } catch {
    throw new Error("Invalid certificate PEM: could not parse as X.509 certificate");
  }
}

export async function createCaCertificateAction(formData: FormData) {
  const session = await requirePermission("certificates:write");
  assertUnscopedCertificates(session.access);
  const userId = Number(session.user.id);
  const name = String(formData.get("name") ?? "").trim();
  const certificatePem = String(formData.get("certificate_pem") ?? "").trim();

  if (!name) throw new Error("Name is required");
  if (!certificatePem) throw new Error("Certificate PEM is required");
  validatePem(certificatePem);

  await createCaCertificate({ name, certificatePem: certificatePem }, userId);
  revalidatePath("/certificates");
}

export async function updateCaCertificateAction(id: number, formData: FormData) {
  const session = await requirePermission("certificates:write");
  assertUnscopedCertificates(session.access);
  const userId = Number(session.user.id);
  const name = formData.get("name") ? String(formData.get("name")).trim() : undefined;
  const certificatePem = formData.get("certificate_pem") ? String(formData.get("certificate_pem")).trim() : undefined;

  if (certificatePem) {
    validatePem(certificatePem);
  }

  await updateCaCertificate(id, {
    ...(name ? { name } : {}),
    ...(certificatePem ? { certificatePem: certificatePem } : {})
  }, userId);
  revalidatePath("/certificates");
}

export async function deleteCaCertificateAction(id: number): Promise<{ success: boolean; error?: string }> {
  const session = await requirePermission("certificates:write");
  assertUnscopedCertificates(session.access);
  const userId = Number(session.user.id);
  try {
    await deleteCaCertificate(id, userId);
    revalidatePath("/certificates");
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to delete CA certificate" };
  }
}

export async function generateCaCertificateAction(formData: FormData): Promise<{ id: number }> {
  const session = await requirePermission("certificates:write");
  assertUnscopedCertificates(session.access);
  const userId = Number(session.user.id);
  const name = String(formData.get("name") ?? "").trim();
  const commonName = String(formData.get("common_name") ?? name).trim() || name;
  const validityDays = Math.min(3650, Math.max(1, parseInt(String(formData.get("validity_days") ?? "3650"), 10) || 3650));

  if (!name) throw new Error("Name is required");

  const keypair = forge.pki.rsa.generateKeyPair({ bits: 4096 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keypair.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + validityDays);

  const attrs = [
    { name: "commonName", value: commonName },
    { name: "organizationName", value: BRAND_NAME },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(keypair.privateKey, forge.md.sha256.create());

  const certificatePem = forge.pki.certificateToPem(cert);
  const privateKeyPem = forge.pki.privateKeyToPem(keypair.privateKey);

  const record = await createCaCertificate({ name, certificatePem: certificatePem, privateKeyPem: privateKeyPem }, userId);
  revalidatePath("/certificates");
  return { id: record.id };
}

export type IssuedClientCert = {
  pkcs12Base64: string;
  passwordProtected: boolean;
  exportAlgorithm: "3des" | "aes256";
};

/**
 * Expected failures are returned as `{ error }` rather than thrown, because
 * production Next.js replaces thrown server-action messages with a generic one.
 */
export type IssueClientCertResult = IssuedClientCert | { error: string };

export async function issueClientCertificateAction(
  caCertId: number,
  formData: FormData
): Promise<IssueClientCertResult> {
  const session = await requirePermission("certificates:write");
  assertUnscopedCertificates(session.access);
  const userId = Number(session.user.id);
  const commonName = String(formData.get("common_name") ?? "").trim();
  const validityDays = Math.min(3650, Math.max(1, parseInt(String(formData.get("validity_days") ?? "365"), 10) || 365));
  const exportPassword = String(formData.get("export_password") ?? "");
  const compatibilityMode = formData.get("compatibility_mode") === "on";
  const exportAlgorithm: IssuedClientCert["exportAlgorithm"] = compatibilityMode ? "3des" : "aes256";

  if (!commonName) return { error: "Common name is required" };
  if (!exportPassword) return { error: "Export password is required" };

  const caCertRecord = await getCaCertificate(caCertId);
  if (!caCertRecord) return { error: "CA certificate not found" };

  let caPrivateKeyPem: string | null;
  try {
    caPrivateKeyPem = await getCaCertificatePrivateKey(caCertId);
  } catch (error) {
    if (error instanceof CaPrivateKeyUnavailableError) return { error: error.message };
    throw error;
  }
  if (!caPrivateKeyPem) return { error: "This CA has no stored private key — cannot issue client certificates" };

  const caKey = forge.pki.privateKeyFromPem(caPrivateKeyPem);
  const caCert = forge.pki.certificateFromPem(caCertRecord.certificatePem);

  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keypair.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + validityDays);

  cert.setSubject([{ name: "commonName", value: commonName }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", clientAuth: true },
  ]);

  cert.sign(caKey, forge.md.sha256.create());
  const certificatePem = forge.pki.certificateToPem(cert);
  const certificate = new X509Certificate(certificatePem);

  await createIssuedClientCertificate(
    {
      caCertificateId: caCertId,
      commonName: commonName,
      serialNumber: cert.serialNumber.toUpperCase(),
      fingerprintSha256: certificate.fingerprint256,
      certificatePem: certificatePem,
      validFrom: new Date(certificate.validFrom).toISOString(),
      validTo: new Date(certificate.validTo).toISOString()
    },
    userId
  );
  revalidatePath("/certificates");

  const pkcs12Asn1 = forge.pkcs12.toPkcs12Asn1(
    keypair.privateKey,
    [cert, caCert],
    exportPassword,
    {
      algorithm: exportAlgorithm,
      friendlyName: commonName,
    }
  );
  const pkcs12Der = forge.asn1.toDer(pkcs12Asn1).getBytes();

  return {
    pkcs12Base64: forge.util.encode64(pkcs12Der),
    passwordProtected: true,
    exportAlgorithm,
  };
}

export async function revokeIssuedClientCertificateAction(id: number): Promise<{ revokedAt: string }> {
  const session = await requirePermission("certificates:write");
  assertUnscopedCertificates(session.access);
  const userId = Number(session.user.id);
  const record = await revokeIssuedClientCertificate(id, userId);
  revalidatePath("/certificates");
  return { revokedAt: record.revokedAt! };
}

/** At most this many client certificates per bulk revoke. */
const MAX_BULK_REVOKE = 500;

export type BulkRevokeResult = { ok: boolean; revoked: number; message: string };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Revokes several client certificates at once: one change batch, so Caddy
 * is applied once at the end; each certificate still gets its own audit
 * event, as revoking one does.
 */
export async function revokeIssuedClientCertificatesAction(ids: unknown): Promise<BulkRevokeResult> {
  const session = await requirePermission("certificates:write");
  assertUnscopedCertificates(session.access);
  const userId = Number(session.user.id);
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("Choose the certificates first.");
  const unique = [...new Set(ids)];
  if (!unique.every((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) {
    throw new Error("Unknown client certificate.");
  }
  if (unique.length > MAX_BULK_REVOKE) throw new Error(`Choose at most ${MAX_BULK_REVOKE} certificates at a time.`);

  const revoked: IssuedClientCertificate[] = [];
  const failed: string[] = [];
  let alreadyRevoked = 0;
  const { applyRequested } = await runAsChangeBatch(async () => {
    for (const id of unique) {
      const existing = await getIssuedClientCertificate(id);
      if (!existing) {
        failed.push(`#${id} (not found)`);
        continue;
      }
      if (existing.revokedAt) {
        alreadyRevoked++;
        continue;
      }
      try {
        revoked.push(await revokeIssuedClientCertificate(id, userId));
      } catch (error) {
        failed.push(`${existing.commonName} (${error instanceof Error ? error.message : "failed"})`);
      }
    }
  });
  // One audit event per certificate, as revoking one records.
  for (const cert of revoked) {
    await logAuditEvent({
      userId,
      action: "revoke",
      entityType: "issued_client_certificate",
      entityId: cert.id,
      summary: `Revoked client certificate ${cert.commonName}`,
      data: { caCertificateId: cert.caCertificateId, serialNumber: cert.serialNumber }
    });
  }
  let applyError: string | null = null;
  if (applyRequested) {
    try {
      await applyCaddyConfig();
    } catch (error) {
      applyError = error instanceof Error ? error.message : "Caddy did not take the new configuration";
    }
  }
  revalidatePath("/certificates");

  const parts: string[] = [];
  if (revoked.length > 0) parts.push(`Revoked ${plural(revoked.length, "certificate")}.`);
  if (alreadyRevoked > 0) parts.push(`${plural(alreadyRevoked, "certificate")} already ${alreadyRevoked === 1 ? "was" : "were"} revoked.`);
  if (failed.length > 0) parts.push(`${plural(failed.length, "certificate")} could not be revoked: ${failed.join("; ")}.`);
  if (applyError) parts.push(`The certificates are revoked, but Caddy did not take the new configuration: ${applyError}`);
  return { ok: failed.length === 0 && applyError === null, revoked: revoked.length, message: parts.join(" ") || "Nothing to revoke." };
}
