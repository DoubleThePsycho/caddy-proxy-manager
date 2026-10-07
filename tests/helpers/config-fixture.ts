import { createHash } from 'node:crypto';
import type { TestDb } from './db';
import * as schema from '../../src/lib/db/schema';
import { encryptSecret } from '../../src/lib/secret';
import { first } from '@/src/lib/db/ops';

/** Secret plaintexts that must never appear in a snapshot or an export file. */
export const CERT_KEY = '-----BEGIN PRIVATE KEY-----\nCERT-PLAINTEXT-KEY-MATERIAL-7f3a\n-----END PRIVATE KEY-----';
export const CA_KEY = '-----BEGIN PRIVATE KEY-----\nCA-PLAINTEXT-KEY-MATERIAL-91bc\n-----END PRIVATE KEY-----';
export const DNS_TOKEN = 'cloudflare-dns-token-PLAINTEXT-5d2e';
export const ENTRY_HASH = '$2b$12$PLAINTEXTHASHVALUEabcdefghijklmnopqrstuvwxyz0123456';

/** Values of rows outside the configuration; none may appear in a snapshot or an export. */
export const OUTSIDE = {
  adminEmail: 'admin@example.com',
  memberEmail: 'member@example.com',
  sessionToken: 'dashboard-session-token-OUTSIDE',
  apiTokenHash: createHash('sha256').update('api-token-OUTSIDE').digest('hex'),
  oauthClientSecret: 'oauth-client-secret-OUTSIDE',
  instanceToken: 'instance-sync-token-OUTSIDE',
  auditSummary: 'audit-summary-OUTSIDE',
  forwardAuthTokenHash: 'forward-auth-token-hash-OUTSIDE',
};

export function now(): string {
  return new Date().toISOString();
}

export async function setSettingRow(db: TestDb, key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  const updatedAt = now();
  await db.insert(schema.settings)
    .values({ key, value: serialized, updatedAt })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: serialized, updatedAt } });
}

export type Fixture = {
  adminId: number;
  memberId: number;
  certId: number;
  caId: number;
  issuedId: number;
  listId: number;
  entryId: number;
  hostId: number;
  l4Id: number;
  roleId: number;
  ruleId: number;
  groupId: number;
};

/** A configuration touching every configuration table, plus rows outside it. */
export async function seedConfiguration(db: TestDb): Promise<Fixture> {
  const t = now();
  const admin = (await first(db.insert(schema.users).values({
    email: OUTSIDE.adminEmail, name: 'Admin', role: 'admin', status: 'active', createdAt: t, updatedAt: t,
  }).returning()))!;
  const member = (await first(db.insert(schema.users).values({
    email: OUTSIDE.memberEmail, name: 'Member', role: 'user', status: 'active', createdAt: t, updatedAt: t,
  }).returning()))!;

  const cert = (await first(db.insert(schema.certificates).values({
    name: 'Imported cert', type: 'imported', domainNames: '["app.example.com"]', autoRenew: false,
    certificatePem: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----',
    privateKeyPem: encryptSecret(CERT_KEY), createdBy: admin.id, createdAt: t, updatedAt: t,
  }).returning()))!;
  const ca = (await first(db.insert(schema.caCertificates).values({
    name: 'Client CA', certificatePem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    privateKeyPem: encryptSecret(CA_KEY), createdBy: admin.id, createdAt: t, updatedAt: t,
  }).returning()))!;
  const issued = (await first(db.insert(schema.issuedClientCertificates).values({
    caCertificateId: ca.id, commonName: 'laptop', serialNumber: '01', fingerprintSha256: 'AA:BB',
    certificatePem: 'CLIENT-PEM', validFrom: t, validTo: '2030-01-01T00:00:00.000Z', createdBy: admin.id,
    createdAt: t, updatedAt: t,
  }).returning()))!;
  const list = (await first(db.insert(schema.accessLists).values({
    name: 'Staff', description: 'Basic auth', createdBy: admin.id, createdAt: t, updatedAt: t,
  }).returning()))!;
  const entry = (await first(db.insert(schema.accessListEntries).values({
    accessListId: list.id, username: 'alice', passwordHash: ENTRY_HASH, createdAt: t, updatedAt: t,
  }).returning()))!;
  const host = (await first(db.insert(schema.proxyHosts).values({
    name: 'App', domains: '["app.example.com"]', upstreams: '["backend:8080"]', certificateId: cert.id,
    accessListId: list.id, ownerUserId: admin.id,
    meta: JSON.stringify({ waf: { enabled: true, mode: 'On' }, custom_headers: { 'X-Env': 'prod' } }),
    createdAt: t, updatedAt: t,
  }).returning()))!;
  const l4 = (await first(db.insert(schema.l4ProxyHosts).values({
    name: 'Postgres', protocol: 'tcp', listenAddress: ':5432', upstreams: '["db:5432"]', ownerUserId: admin.id,
    createdAt: t, updatedAt: t,
  }).returning()))!;
  const role = (await first(db.insert(schema.mtlsRoles).values({
    name: 'ops', description: 'Operators', createdBy: admin.id, createdAt: t, updatedAt: t,
  }).returning()))!;
  await db.insert(schema.mtlsCertificateRoles).values({ issuedClientCertificateId: issued.id, mtlsRoleId: role.id, createdAt: t });
  const rule = (await first(db.insert(schema.mtlsAccessRules).values({
    proxyHostId: host.id, pathPattern: '/admin/*', allowedRoleIds: JSON.stringify([role.id]), createdBy: admin.id,
    createdAt: t, updatedAt: t,
  }).returning()))!;
  const group = (await first(db.insert(schema.groups).values({
    name: 'Developers', createdBy: admin.id, createdAt: t, updatedAt: t,
  }).returning()))!;
  await db.insert(schema.forwardAuthAccess).values({ proxyHostId: host.id, groupId: group.id, createdAt: t });
  await db.insert(schema.forwardAuthAccess).values({ proxyHostId: host.id, userId: member.id, createdAt: t });

  await setSettingRow(db, 'general', { primaryDomain: 'example.com', acmeEmail: 'acme@example.com' });
  await setSettingRow(db, 'dns_provider', { providers: { cloudflare: { api_token: encryptSecret(DNS_TOKEN) } }, default: 'cloudflare' });
  await setSettingRow(db, 'waf', { enabled: true, mode: 'On', load_owasp_crs: true, custom_directives: '' });

  // Outside the configuration.
  await db.insert(schema.groupMembers).values({ groupId: group.id, userId: member.id, createdAt: t });
  await db.insert(schema.sessions).values({
    userId: admin.id, token: OUTSIDE.sessionToken, expiresAt: '2099-01-01T00:00:00.000Z', createdAt: t, updatedAt: t,
  });
  await db.insert(schema.apiTokens).values({ name: 'ci', tokenHash: OUTSIDE.apiTokenHash, createdBy: admin.id, createdAt: t });
  await db.insert(schema.oauthProviders).values({
    id: 'idp', name: 'IdP', clientId: 'client', clientSecret: OUTSIDE.oauthClientSecret, createdAt: t, updatedAt: t,
  });
  await db.insert(schema.instances).values({
    name: 'replica', baseUrl: 'https://replica.example.com', apiToken: OUTSIDE.instanceToken, createdAt: t, updatedAt: t,
  });
  await db.insert(schema.auditEvents).values({ action: 'create', entityType: 'proxy_host', summary: OUTSIDE.auditSummary, createdAt: t });
  await db.insert(schema.forwardAuthSessions).values({
    userId: member.id, proxyHostId: host.id, audienceOrigin: 'https://app.example.com',
    tokenHash: OUTSIDE.forwardAuthTokenHash, expiresAt: '2099-01-01T00:00:00.000Z', createdAt: t,
  });
  await setSettingRow(db, 'instance_mode', 'standalone');

  return {
    adminId: admin.id, memberId: member.id, certId: cert.id, caId: ca.id, issuedId: issued.id, listId: list.id,
    entryId: entry.id, hostId: host.id, l4Id: l4.id, roleId: role.id, ruleId: rule.id, groupId: group.id,
  };
}
