// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: the model's checks on certificates. A certificate belongs to
 * one organisation (or the provider level); an organisation user reaches only
 * their organisation's. The names a certificate covers (the stored domain
 * names, and the names in an imported PEM, which is what Caddy matches) must
 * not be served or held by another organisation (domains.ts), so no tenant can
 * obtain or load a certificate for another tenant's domain.
 */
import { appDb } from "@/src/lib/db";
import { assertNamesFreeAcrossOrganizations, certificatePemNames } from "./domains";
import { assertActorReaches, organizationForNewRow } from "./scope";

type CertificateNames = { domainNames: readonly string[]; certificatePem?: string | null };

function namesOf(certificate: CertificateNames): string[] {
  return [...certificate.domainNames, ...certificatePemNames(certificate.certificatePem)];
}

/** Checks before `actorUserId` creates a certificate; returns its organisation. */
export async function checkCertificateCreate(actorUserId: number, requested: unknown, certificate: CertificateNames): Promise<number | null> {
  const organizationId = await organizationForNewRow(actorUserId, requested);
  await assertNamesFreeAcrossOrganizations(appDb, organizationId, namesOf(certificate));
  return organizationId;
}

/** Checks before `actorUserId` changes certificate `id` of `organizationId` to `next`. */
export async function checkCertificateUpdate(actorUserId: number, id: number, organizationId: number | null, next: CertificateNames): Promise<void> {
  await assertActorReaches(actorUserId, organizationId, "Certificate not found");
  await assertNamesFreeAcrossOrganizations(appDb, organizationId, namesOf(next), { certificateId: id });
}

/** 404 unless `actorUserId` may reach a certificate of `organizationId` (change or delete it). */
export async function checkCertificateReach(actorUserId: number, organizationId: number | null): Promise<void> {
  await assertActorReaches(actorUserId, organizationId, "Certificate not found");
}

