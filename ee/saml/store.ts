// SPDX-License-Identifier: Elastic-2.0
/**
 * Reading stored SAML providers, for sign-in and for the administration
 * code. Nothing here looks at the license: sign-in through a provider that
 * is already set up keeps working without one.
 */
import { and, eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { samlGroupRoles, samlProviders } from "@/src/lib/db/schema";
import { config } from "@/src/lib/config";
import { decryptSecret } from "@/src/lib/secret";
import { SAML_ROLES, type SamlRole } from "./constants";
import type { SamlGroupRoleMapping, SamlProviderConfig, SamlServiceProviderUrls } from "./types";
import { asc, first } from "@/src/lib/db/ops";
import type { DbExecutor } from "@/src/lib/db/types";

export type SamlProviderRow = typeof samlProviders.$inferSelect;

/** The database or a transaction on it, for reads. */
export type SamlReader = Pick<DbExecutor, "select">;

/** A provider's settings without its id and SP private key. */
export type SamlProviderSettings = Omit<SamlProviderConfig, "id" | "spPrivateKey">;

/** BASE_URL without a trailing slash. */
export function baseUrl(): string {
  return config.baseUrl.replace(/\/+$/, "");
}

/**
 * The SP entity ID, ACS URL and metadata URL of provider `id`. The entity
 * ID is the metadata URL, a common convention that lets an IdP fetch the
 * metadata from it. Changing BASE_URL changes all three, so the IdP has to
 * be updated too.
 */
export function serviceProviderUrls(id: number): SamlServiceProviderUrls {
  const base = `${baseUrl()}/api/auth/saml`;
  return {
    entityId: `${base}/metadata/${id}`,
    acsUrl: `${base}/acs/${id}`,
    metadataUrl: `${base}/metadata/${id}`,
  };
}

/** Whether browsers keep the Secure binding cookie: BASE_URL is https, or http on the loopback host. */
export function baseUrlIsSecureContext(): boolean {
  try {
    const url = new URL(baseUrl());
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function readStoredCertificates(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  } catch {
    return [];
  }
}

export async function readMappings(reader: SamlReader, providerId: number): Promise<SamlGroupRoleMapping[]> {
  return (await reader
    .select({ group: samlGroupRoles.groupValue, role: samlGroupRoles.role })
    .from(samlGroupRoles)
    .where(eq(samlGroupRoles.providerId, providerId))
    .orderBy(asc(samlGroupRoles.id)))
    .filter((row): row is { group: string; role: SamlRole } => (SAML_ROLES as readonly string[]).includes(row.role));
}

/** The stored row as settings (the starting point of an update). */
export async function rowSettings(row: SamlProviderRow, reader: SamlReader = appDb): Promise<SamlProviderSettings> {
  return {
    name: row.name,
    enabled: row.enabled,
    idpEntityId: row.idpEntityId,
    idpSsoUrl: row.idpSsoUrl,
    idpCertificates: readStoredCertificates(row.idpCertificates),
    spCertificate: row.spCertificate,
    subjectAttribute: row.subjectAttribute,
    emailAttribute: row.emailAttribute,
    nameAttribute: row.nameAttribute,
    groupsAttribute: row.groupsAttribute,
    groupRoleMappings: await readMappings(reader, row.id),
    defaultRole: row.defaultRole === "viewer" ? "viewer" : "user",
    requiredGroup: row.requiredGroup,
    provisionUsers: row.provisionUsers,
    linkExistingAccounts: row.linkExistingAccounts,
  };
}

export async function getProviderRow(id: number, reader: SamlReader = appDb): Promise<SamlProviderRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return await first(reader.select().from(samlProviders).where(eq(samlProviders.id, id)).limit(1)) ?? null;
}

export async function getEnabledProviderRow(id: number, reader: SamlReader = appDb): Promise<SamlProviderRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return await first(reader
    .select()
    .from(samlProviders)
    .where(and(eq(samlProviders.id, id), eq(samlProviders.enabled, true)))
    .limit(1)) ?? null;
}

/** Thrown when the stored SP key cannot be decrypted (SESSION_SECRET changed without SESSION_SECRET_PREVIOUS). */
export class SamlProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamlProviderUnavailableError";
  }
}

/** The provider as sign-in uses it, with the SP signing key decrypted. */
export async function toProviderConfig(row: SamlProviderRow, reader: SamlReader = appDb): Promise<SamlProviderConfig> {
  let spPrivateKey: string | null = null;
  if (row.spPrivateKey) {
    try {
      spPrivateKey = decryptSecret(row.spPrivateKey, `SAML provider ${row.id} SP signing key`);
    } catch {
      throw new SamlProviderUnavailableError(
        "The stored SP signing key cannot be decrypted with SESSION_SECRET; generate or enter a new one"
      );
    }
  }
  return { id: row.id, ...await rowSettings(row, reader), spPrivateKey };
}

/** The providers the login page offers: the enabled ones. SAML is single sign-on, so enforced SSO keeps them. */
export async function listLoginSamlProviders(reader: SamlReader = appDb): Promise<Array<{ id: number; name: string }>> {
  return await reader
    .select({ id: samlProviders.id, name: samlProviders.name })
    .from(samlProviders)
    .where(eq(samlProviders.enabled, true))
    .orderBy(asc(samlProviders.name), asc(samlProviders.id));
}
