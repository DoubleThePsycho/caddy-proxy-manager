// SPDX-License-Identifier: Elastic-2.0
/**
 * SAML identity providers: validation, storage and the administrator
 * actions on them, shared by the REST API (/api/v1/saml-providers) and the
 * dashboard. This is the only way providers are created or changed: the
 * Better Auth plugin (plugin.ts) has no management routes.
 *
 * Providers are per dashboard, like the users and accounts they sign in:
 * they are not synced to slaves, like OAuth providers.
 */
import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import forge from "node-forge";
import { count, eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { accounts, samlGroupRoles, samlProviders } from "@/src/lib/db/schema";
import { encryptSecret } from "@/src/lib/secret";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { LIMITS, SAML_DEFAULT_ROLES, SAML_ROLES, samlProviderId, type SamlRole } from "./constants";
import { buildServiceProviderMetadata, parseIdpMetadata } from "./metadata";
import { deleteProviderState } from "./requests";
import {
  baseUrlIsSecureContext,
  getProviderRow,
  rowSettings,
  serviceProviderUrls,
  type SamlProviderRow,
  type SamlProviderSettings,
} from "./store";
import type { SamlCertificateSummary, SamlGroupRoleMapping, SamlProviderView } from "./types";
import { XmlInputError } from "./xml";
import { asc, first } from "@/src/lib/db/ops";
import type { AppTx } from "@/src/lib/db/types";

export const PROVIDER_NOT_FOUND = "SAML provider not found";

const DEFAULTS = {
  emailAttribute: "email",
  defaultRole: "user" as const,
};

const FIELDS = [
  "name",
  "enabled",
  "idpMetadataXml",
  "idpEntityId",
  "idpSsoUrl",
  "idpCertificates",
  "spPrivateKey",
  "spCertificate",
  "generateSpKey",
  "subjectAttribute",
  "emailAttribute",
  "nameAttribute",
  "groupsAttribute",
  "groupRoleMappings",
  "defaultRole",
  "requiredGroup",
  "provisionUsers",
  "linkExistingAccounts",
] as const;

// ── Validation ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function rejectUnknownKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (!(FIELDS as readonly string[]).includes(key)) throw new ApiValidationError(`Unknown field "${key.slice(0, 64)}"`);
  }
}

function parseName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError("name is required");
  const name = value.trim();
  if (name.length > LIMITS.name) throw new ApiValidationError(`name must be at most ${LIMITS.name} characters`);
  if (CONTROL.test(name)) throw new ApiValidationError("name must not contain control characters");
  return name;
}

function parseBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ApiValidationError(`${field} must be true or false`);
  return value;
}

function parseEntityId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError("idpEntityId is required");
  const entityId = value.trim();
  if (entityId.length > LIMITS.entityId || CONTROL.test(entityId)) {
    throw new ApiValidationError(`idpEntityId must be at most ${LIMITS.entityId} characters without control characters`);
  }
  return entityId;
}

/** https://, or http:// on the loopback host (a local test IdP). Messages never echo the URL. */
export function parseSsoUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError("idpSsoUrl is required");
  const text = value.trim();
  if (text.length > LIMITS.url) throw new ApiValidationError("idpSsoUrl is too long");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ApiValidationError("idpSsoUrl must be a URL such as https://idp.example.com/saml/sso");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ApiValidationError("idpSsoUrl must use https://");
  }
  if (url.username || url.password) throw new ApiValidationError("idpSsoUrl must not contain credentials");
  if (url.hash) throw new ApiValidationError("idpSsoUrl must not have a fragment");
  return url.toString();
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function normalizeCertificate(pem: string): string {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch {
    throw new ApiValidationError("idpCertificates holds a certificate that cannot be read");
  }
  const type = certificate.publicKey.asymmetricKeyType;
  if (type !== "rsa" && type !== "rsa-pss") {
    throw new ApiValidationError("idpCertificates must hold RSA certificates (EC signatures are not supported)");
  }
  return certificate.toString().trim();
}

/** One or more PEM certificates, as an array or in one string. */
function parseCertificates(value: unknown): string[] {
  const texts = Array.isArray(value) ? value : [value];
  const blocks: string[] = [];
  for (const text of texts) {
    if (typeof text !== "string") throw new ApiValidationError("idpCertificates must be PEM certificates");
    if (text.length > LIMITS.certificate * LIMITS.certificates) throw new ApiValidationError("idpCertificates is too large");
    if (/PRIVATE KEY/.test(text)) throw new ApiValidationError("idpCertificates must hold certificates only, never a private key");
    const found = text.match(PEM_CERTIFICATE) ?? [];
    if (found.length === 0 && text.trim()) throw new ApiValidationError("idpCertificates must be PEM certificates");
    blocks.push(...found);
  }
  const certificates = [...new Set(blocks.map(normalizeCertificate))];
  if (certificates.length === 0) throw new ApiValidationError("idpCertificates needs at least one signing certificate");
  if (certificates.length > LIMITS.certificates) {
    throw new ApiValidationError(`idpCertificates takes at most ${LIMITS.certificates} certificates`);
  }
  return certificates;
}

/** An attribute name as the IdP sends it: a name or a URI, printable ASCII without spaces. */
function isAttributeName(value: string): boolean {
  return value.length > 0 && value.length <= LIMITS.attribute && /^[\x21-\x7e]+$/.test(value);
}

function parseAttribute(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !isAttributeName(value.trim())) {
    throw new ApiValidationError(`${field} must be an attribute name (printable characters without spaces, at most ${LIMITS.attribute})`);
  }
  return value.trim();
}

function parseOptionalAttribute(value: unknown, field: string, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null || (typeof value === "string" && !value.trim())) return null;
  return parseAttribute(value, field, "");
}

function parseGroup(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError(`${field} is required`);
  const group = value.trim();
  if (group.length > LIMITS.group || CONTROL.test(group)) {
    throw new ApiValidationError(`${field} must be at most ${LIMITS.group} characters without control characters`);
  }
  return group;
}

function parseOptionalGroup(value: unknown, field: string, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null || (typeof value === "string" && !value.trim())) return null;
  return parseGroup(value, field);
}

function parseMappings(value: unknown, fallback: SamlGroupRoleMapping[]): SamlGroupRoleMapping[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new ApiValidationError("groupRoleMappings must be an array of {group, role}");
  if (value.length > LIMITS.mappings) throw new ApiValidationError(`groupRoleMappings takes at most ${LIMITS.mappings} entries`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new ApiValidationError(`groupRoleMappings[${index}] must be an object with group and role`);
    for (const key of Object.keys(item)) {
      if (key !== "group" && key !== "role") throw new ApiValidationError(`groupRoleMappings[${index}] has an unknown field "${key.slice(0, 64)}"`);
    }
    const group = parseGroup(item.group, `groupRoleMappings[${index}].group`);
    if (typeof item.role !== "string" || !(SAML_ROLES as readonly string[]).includes(item.role)) {
      throw new ApiValidationError(`groupRoleMappings[${index}].role must be one of ${SAML_ROLES.join(", ")}`);
    }
    if (seen.has(group)) throw new ApiValidationError(`groupRoleMappings lists the group ${group.slice(0, 80)} twice`);
    seen.add(group);
    return { group, role: item.role as SamlRole };
  });
}

function parseDefaultRole(value: unknown, fallback: "user" | "viewer"): "user" | "viewer" {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !(SAML_DEFAULT_ROLES as readonly string[]).includes(value)) {
    throw new ApiValidationError(`defaultRole must be one of ${SAML_DEFAULT_ROLES.join(", ")}; administrators come from a group mapping only`);
  }
  return value as "user" | "viewer";
}

/** A new self-signed RSA certificate and key for signing AuthnRequests (10 years). */
export function generateSpSigningKey(commonName: string): { privateKey: string; certificate: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }).toString());
  cert.serialNumber = `01${randomBytes(15).toString("hex")}`;
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 60_000);
  cert.validity.notAfter = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: "commonName", value: commonName.slice(0, 64) }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forge.pki.privateKeyFromPem(privatePem) as forge.pki.rsa.PrivateKey, forge.md.sha256.create());
  return { privateKey: privatePem, certificate: forge.pki.certificateToPem(cert).trim() };
}

type SpKeyChange = { action: "keep" } | { action: "remove" } | { action: "set"; privateKey: string; certificate: string };

/** The SP signing key of the body: generated, given (key and certificate that match), removed (null) or kept. */
function parseSpKey(body: Record<string, unknown>, name: string): SpKeyChange {
  const generate = parseBoolean(body.generateSpKey, "generateSpKey", false);
  const key = body.spPrivateKey;
  const certificate = body.spCertificate;
  if (generate) {
    if (key !== undefined || certificate !== undefined) {
      throw new ApiValidationError("Send generateSpKey or spPrivateKey with spCertificate, not both");
    }
    return { action: "set", ...generateSpSigningKey(`${name} SAML SP`) };
  }
  if (key === undefined && certificate === undefined) return { action: "keep" };
  if (key === null) {
    if (certificate !== undefined && certificate !== null) throw new ApiValidationError("spCertificate goes with spPrivateKey");
    return { action: "remove" };
  }
  if (typeof key !== "string" || typeof certificate !== "string") {
    throw new ApiValidationError("spPrivateKey and spCertificate are set together, as PEM; or send generateSpKey: true");
  }
  if (key.length > LIMITS.privateKey || certificate.length > LIMITS.certificate) throw new ApiValidationError("The SP key or certificate is too large");
  let privateKey;
  let x509: X509Certificate;
  try {
    privateKey = createPrivateKey({ key, format: "pem" });
  } catch {
    throw new ApiValidationError("spPrivateKey must be an unencrypted PEM private key");
  }
  try {
    x509 = new X509Certificate(certificate);
  } catch {
    throw new ApiValidationError("spCertificate must be a PEM certificate");
  }
  if (privateKey.asymmetricKeyType !== "rsa") throw new ApiValidationError("spPrivateKey must be an RSA key");
  const matches = createPublicKey(privateKey).export({ type: "spki", format: "der" })
    .equals(x509.publicKey.export({ type: "spki", format: "der" }));
  if (!matches) throw new ApiValidationError("spCertificate does not belong to spPrivateKey");
  return {
    action: "set",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certificate: x509.toString().trim(),
  };
}

/** A provider as validated input; spKey says what happens to the SP signing key. */
export type ParsedProvider = SamlProviderSettings & { spKey: SpKeyChange };

/**
 * Validates a create (existing null) or update body. Fields left out keep
 * their stored values (or get the defaults on create). IdP metadata, when
 * sent, fills the entity ID, the SSO URL and the certificates unless the
 * body sets them too; it is parsed here and never fetched.
 */
async function parseProvider(body: unknown, existing: SamlProviderRow | null): Promise<ParsedProvider> {
  if (!isRecord(body)) throw new ApiValidationError("Request body must be a JSON object");
  rejectUnknownKeys(body);
  const stored = existing ? await rowSettings(existing) : null;

  let metadata: ReturnType<typeof parseIdpMetadata> | null = null;
  if (body.idpMetadataXml !== undefined && body.idpMetadataXml !== null && body.idpMetadataXml !== "") {
    if (typeof body.idpMetadataXml !== "string") throw new ApiValidationError("idpMetadataXml must be the metadata XML as a string");
    try {
      metadata = parseIdpMetadata(body.idpMetadataXml);
    } catch (error) {
      if (error instanceof XmlInputError) throw new ApiValidationError(error.message);
      throw error;
    }
  }

  const name = body.name === undefined && stored ? stored.name : parseName(body.name);
  const idpEntityId = body.idpEntityId !== undefined
    ? parseEntityId(body.idpEntityId)
    : metadata?.entityId !== undefined ? parseEntityId(metadata.entityId) : stored ? stored.idpEntityId : parseEntityId(undefined);
  const idpSsoUrl = body.idpSsoUrl !== undefined
    ? parseSsoUrl(body.idpSsoUrl)
    : metadata ? parseSsoUrl(metadata.ssoUrl) : stored ? stored.idpSsoUrl : parseSsoUrl(undefined);
  const idpCertificates = body.idpCertificates !== undefined
    ? parseCertificates(body.idpCertificates)
    : metadata ? parseCertificates(metadata.certificates) : stored ? stored.idpCertificates : parseCertificates(undefined);

  const groupsAttribute = parseOptionalAttribute(body.groupsAttribute, "groupsAttribute", stored?.groupsAttribute ?? null);
  const groupRoleMappings = parseMappings(body.groupRoleMappings, stored?.groupRoleMappings ?? []);
  const requiredGroup = parseOptionalGroup(body.requiredGroup, "requiredGroup", stored?.requiredGroup ?? null);
  if (!groupsAttribute && groupRoleMappings.length > 0) throw new ApiValidationError("groupRoleMappings need groupsAttribute");
  if (!groupsAttribute && requiredGroup) throw new ApiValidationError("requiredGroup needs groupsAttribute");

  return {
    name,
    enabled: parseBoolean(body.enabled, "enabled", stored?.enabled ?? true),
    idpEntityId,
    idpSsoUrl,
    idpCertificates,
    spCertificate: stored?.spCertificate ?? null,
    subjectAttribute: parseOptionalAttribute(body.subjectAttribute, "subjectAttribute", stored?.subjectAttribute ?? null),
    emailAttribute: parseAttribute(body.emailAttribute, "emailAttribute", stored?.emailAttribute ?? DEFAULTS.emailAttribute),
    nameAttribute: parseOptionalAttribute(body.nameAttribute, "nameAttribute", stored?.nameAttribute ?? null),
    groupsAttribute,
    groupRoleMappings,
    defaultRole: parseDefaultRole(body.defaultRole, stored?.defaultRole ?? DEFAULTS.defaultRole),
    requiredGroup,
    provisionUsers: parseBoolean(body.provisionUsers, "provisionUsers", stored?.provisionUsers ?? false),
    linkExistingAccounts: parseBoolean(body.linkExistingAccounts, "linkExistingAccounts", stored?.linkExistingAccounts ?? false),
    spKey: parseSpKey(body, name),
  };
}

export async function parseProviderCreate(body: unknown): Promise<ParsedProvider> {
  return await parseProvider(body, null);
}

export async function parseProviderUpdate(body: unknown, existing: SamlProviderRow): Promise<ParsedProvider> {
  return await parseProvider(body, existing);
}

/**
 * Whether an update only turns the provider off: `enabled: false`, with any
 * other field repeating its stored value. Nothing stored is validated again,
 * so a provider can always be turned off.
 */
export async function isDisableOnlyUpdate(body: unknown, existing: SamlProviderRow): Promise<boolean> {
  if (!isRecord(body) || body.enabled !== false) return false;
  const stored = await rowSettings(existing) as unknown as Record<string, unknown>;
  return Object.entries(body).every(([key, value]) => {
    if (key === "enabled") return true;
    if (!(key in stored)) return false;
    const current = stored[key];
    if (typeof value === "string") return value.trim() === (current ?? "");
    if (value === null) return current === null;
    return JSON.stringify(value) === JSON.stringify(current);
  });
}

// ── Storage ──────────────────────────────────────────────────────────

function fingerprint(certificate: X509Certificate): string {
  return createHash("sha256").update(certificate.raw).digest("hex").toUpperCase().match(/.{2}/g)!.join(":");
}

export function summarizeCertificates(pems: readonly string[], now: number = Date.now()): SamlCertificateSummary[] {
  return pems.flatMap((pem) => {
    try {
      const certificate = new X509Certificate(pem);
      return [{
        subject: certificate.subject.replace(/\n/g, ", "),
        issuer: certificate.issuer.replace(/\n/g, ", "),
        notBefore: new Date(certificate.validFrom).toISOString(),
        notAfter: new Date(certificate.validTo).toISOString(),
        fingerprint: fingerprint(certificate),
        expired: Date.parse(certificate.validTo) <= now,
      }];
    } catch {
      return [];
    }
  });
}

/** Settings worth a second look; shown with the provider, never blocking. */
export function providerWarnings(settings: SamlProviderSettings, certificates: SamlCertificateSummary[]): string[] {
  const warnings: string[] = [];
  if (!baseUrlIsSecureContext()) {
    warnings.push("BASE_URL does not use https, so browsers drop the sign-in cookie SAML needs. Sign-in is refused until it does.");
  }
  if (certificates.length > 0 && certificates.every((certificate) => certificate.expired)) {
    warnings.push("Every signing certificate has expired. Signatures still verify against them; add the IdP's new certificate before it switches.");
  }
  if (settings.subjectAttribute === null) {
    warnings.push("Accounts are linked by the NameID, which must be persistent; responses with another NameID format are refused.");
  }
  if (settings.provisionUsers && !settings.requiredGroup) {
    warnings.push("Every user the identity provider signs in gets an account at first sign-in. Consider a required group.");
  }
  if (settings.subjectAttribute !== null && settings.subjectAttribute === settings.emailAttribute) {
    warnings.push("Accounts are linked by the e-mail address, which can change at the identity provider. Prefer an immutable id attribute.");
  }
  return warnings;
}

async function linkedAccountCounts(): Promise<Map<string, number>> {
  const rows = await appDb
    .select({ providerId: accounts.providerId, total: count() })
    .from(accounts)
    .groupBy(accounts.providerId);
  return new Map(rows.map((row) => [row.providerId, row.total]));
}

export async function toProviderView(row: SamlProviderRow, linked?: number): Promise<SamlProviderView> {
  const settings = await rowSettings(row);
  const certificates = summarizeCertificates(settings.idpCertificates);
  return {
    id: row.id,
    ...settings,
    hasSpPrivateKey: Boolean(row.spPrivateKey),
    signsRequests: Boolean(row.spPrivateKey && row.spCertificate),
    certificates,
    sp: serviceProviderUrls(row.id),
    linkedAccounts: linked ?? (await linkedAccountCounts()).get(samlProviderId(row.id)) ?? 0,
    warnings: providerWarnings(settings, certificates),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function requireProviderRow(id: number): Promise<SamlProviderRow> {
  const row = await getProviderRow(id);
  if (!row) throw new ApiClientError(PROVIDER_NOT_FOUND, 404);
  return row;
}

export async function listProviders(): Promise<SamlProviderView[]> {
  const counts = await linkedAccountCounts();
  const rows = await appDb
    .select()
    .from(samlProviders)
    .orderBy(asc(samlProviders.name), asc(samlProviders.id));
  return Promise.all(rows.map((row) => toProviderView(row, counts.get(samlProviderId(row.id)) ?? 0)));
}

export async function getProvider(id: number): Promise<SamlProviderView> {
  return await toProviderView(await requireProviderRow(id));
}

/** The SP metadata XML of a provider (for the IdP). */
export async function getProviderMetadata(id: number): Promise<string> {
  const row = await requireProviderRow(id);
  return buildServiceProviderMetadata({
    id: row.id,
    spCertificate: row.spCertificate,
    signsRequests: Boolean(row.spPrivateKey && row.spCertificate),
    subjectAttribute: row.subjectAttribute,
  });
}

async function assertNameAvailable(name: string, exceptId: number | null): Promise<void> {
  const clash = await first(appDb.select({ id: samlProviders.id }).from(samlProviders).where(eq(samlProviders.name, name)).limit(1));
  if (clash && clash.id !== exceptId) throw new ApiConflictError(`A SAML provider named "${name}" already exists`);
}

function auditData(input: ParsedProvider) {
  return {
    name: input.name,
    enabled: input.enabled,
    idpEntityId: input.idpEntityId,
    idpSsoUrl: input.idpSsoUrl,
    certificates: summarizeCertificates(input.idpCertificates).map((certificate) => certificate.fingerprint),
    subjectAttribute: input.subjectAttribute,
    emailAttribute: input.emailAttribute,
    nameAttribute: input.nameAttribute,
    groupsAttribute: input.groupsAttribute,
    groupRoleMappings: input.groupRoleMappings,
    defaultRole: input.defaultRole,
    requiredGroup: input.requiredGroup,
    provisionUsers: input.provisionUsers,
    linkExistingAccounts: input.linkExistingAccounts,
    spKey: input.spKey.action,
  };
}

function columns(input: ParsedProvider) {
  const key = input.spKey.action === "set"
    ? { spPrivateKey: encryptSecret(input.spKey.privateKey), spCertificate: input.spKey.certificate }
    : input.spKey.action === "remove"
      ? { spPrivateKey: null, spCertificate: null }
      : {};
  return {
    name: input.name,
    enabled: input.enabled,
    idpEntityId: input.idpEntityId,
    idpSsoUrl: input.idpSsoUrl,
    idpCertificates: JSON.stringify(input.idpCertificates),
    ...key,
    subjectAttribute: input.subjectAttribute,
    emailAttribute: input.emailAttribute,
    nameAttribute: input.nameAttribute,
    groupsAttribute: input.groupsAttribute,
    defaultRole: input.defaultRole,
    requiredGroup: input.requiredGroup,
    provisionUsers: input.provisionUsers,
    linkExistingAccounts: input.linkExistingAccounts,
  };
}

async function writeMappings(tx: AppTx, providerId: number, mappings: readonly SamlGroupRoleMapping[]): Promise<void> {
  await tx.delete(samlGroupRoles).where(eq(samlGroupRoles.providerId, providerId));
  const stamp = nowIso();
  for (const mapping of mappings) {
    await tx.insert(samlGroupRoles).values({ providerId, groupValue: mapping.group, role: mapping.role, createdAt: stamp });
  }
}

// ── Administrator actions ────────────────────────────────────────────

export async function createProvider(body: unknown, actorUserId: number): Promise<SamlProviderView> {
  const input = await parseProviderCreate(body);
  await assertNameAvailable(input.name, null);
  const stamp = nowIso();
  const row = await appDb.transaction(async (tx) => {
    const inserted = (await first(tx
      .insert(samlProviders)
      .values({ ...columns(input), createdBy: actorUserId, createdAt: stamp, updatedAt: stamp })
      .returning()))!;
    await writeMappings(tx, inserted.id, input.groupRoleMappings);
    return inserted;
  });
  await logAuditEvent({
    userId: actorUserId,
    action: "saml_provider_created",
    entityType: "saml_provider",
    entityId: row.id,
    summary: `Created SAML provider "${input.name}" (${input.idpEntityId})`,
    data: auditData(input),
  });
  return await toProviderView(row, 0);
}

export async function updateProvider(id: number, body: unknown, actorUserId: number): Promise<SamlProviderView> {
  const existing = await requireProviderRow(id);
  if (await isDisableOnlyUpdate(body, existing)) {
    // Turning off: nothing stored is validated again.
    const row = (await first(appDb
      .update(samlProviders)
      .set({ enabled: false, updatedAt: nowIso() })
      .where(eq(samlProviders.id, id))
      .returning()))!;
    await logAuditEvent({
      userId: actorUserId,
      action: "saml_provider_updated",
      entityType: "saml_provider",
      entityId: id,
      summary: `Updated SAML provider "${existing.name}": disabled`,
      data: { name: existing.name, enabled: false },
    });
    return await toProviderView(row);
  }
  const input = await parseProviderUpdate(body, existing);
  await assertNameAvailable(input.name, id);
  const row = await appDb.transaction(async (tx) => {
    const updated = (await first(tx
      .update(samlProviders)
      .set({ ...columns(input), updatedAt: nowIso() })
      .where(eq(samlProviders.id, id))
      .returning()))!;
    await writeMappings(tx, id, input.groupRoleMappings);
    return updated;
  });

  const before = await rowSettings(existing);
  const changes: string[] = [];
  if (input.enabled !== existing.enabled) changes.push(input.enabled ? "enabled" : "disabled");
  if (input.name !== existing.name) changes.push("name");
  if (input.idpEntityId !== before.idpEntityId || input.idpSsoUrl !== before.idpSsoUrl) changes.push("identity provider");
  if (JSON.stringify(input.idpCertificates) !== JSON.stringify(before.idpCertificates)) changes.push("signing certificates");
  if (input.spKey.action !== "keep") changes.push(input.spKey.action === "set" ? "SP signing key replaced" : "SP signing key removed");
  if (input.subjectAttribute !== before.subjectAttribute || input.emailAttribute !== before.emailAttribute ||
      input.nameAttribute !== before.nameAttribute || input.groupsAttribute !== before.groupsAttribute) changes.push("attributes");
  if (JSON.stringify(input.groupRoleMappings) !== JSON.stringify(before.groupRoleMappings) ||
      input.defaultRole !== before.defaultRole || input.requiredGroup !== before.requiredGroup) changes.push("roles");
  if (input.provisionUsers !== before.provisionUsers || input.linkExistingAccounts !== before.linkExistingAccounts) changes.push("accounts");
  await logAuditEvent({
    userId: actorUserId,
    action: "saml_provider_updated",
    entityType: "saml_provider",
    entityId: id,
    summary: `Updated SAML provider "${input.name}"${changes.length ? `: ${changes.join(", ")}` : ""}`,
    data: auditData(input),
  });
  return await toProviderView(row);
}

/**
 * The accounts signed in through the provider, its group
 * mappings, its sign-ins in progress and its replay records are deleted in
 * the same transaction (foreign keys are not enforced); the users themselves
 * are kept, and those without another way to sign in can no longer sign in
 * until an administrator gives them one.
 */
export async function deleteProvider(id: number, actorUserId: number): Promise<void> {
  const existing = await requireProviderRow(id);
  const providerId = samlProviderId(id);
  const unlinked = await appDb.transaction(async (tx) => {
    const rows = await tx.delete(accounts).where(eq(accounts.providerId, providerId)).returning({ userId: accounts.userId });
    await tx.delete(samlGroupRoles).where(eq(samlGroupRoles.providerId, id));
    await deleteProviderState(tx, id);
    await tx.delete(samlProviders).where(eq(samlProviders.id, id));
    return [...new Set(rows.map((row) => row.userId))];
  });
  // Keep users.provider/subject in step with the accounts that are left (#261).
  const { syncUserOAuthIdentity } = await import("@/src/lib/models/user");
  for (const userId of unlinked) {
    try {
      await syncUserOAuthIdentity(userId);
    } catch (error) {
      console.warn(`[saml] Failed to update the sign-in method shown for user ${userId}:`, error);
    }
  }
  await logAuditEvent({
    userId: actorUserId,
    action: "saml_provider_deleted",
    entityType: "saml_provider",
    entityId: id,
    summary: `Deleted SAML provider "${existing.name}" and unlinked ${unlinked.length} account${unlinked.length === 1 ? "" : "s"}`,
    data: { name: existing.name, idpEntityId: existing.idpEntityId, unlinkedUserIds: unlinked },
  });
}
