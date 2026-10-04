/**
 * Fixtures for the compliance report and incident draft tests: certificates
 * with chosen validity, and a seeded install with users, tokens, roles,
 * groups, certificates, hosts and audit events, plus secret sentinels that
 * must never appear in a report.
 */
import { createHash } from 'node:crypto';
import forge from 'node-forge';
import type { TestDb } from './db';
import * as schema from '../../src/lib/db/schema';
import { encryptSecret } from '../../src/lib/secret';
import { first } from '@/src/lib/db/ops';

const DAY = 24 * 60 * 60 * 1000;

let keypair: forge.pki.rsa.KeyPair | null = null;
function testKeypair(): forge.pki.rsa.KeyPair {
  // One small key for every test certificate keeps the tests fast.
  keypair ??= forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  return keypair;
}

export function pemKeyOfTestCertificates(): string {
  return forge.pki.privateKeyToPem(testKeypair().privateKey);
}

/** A self-signed certificate valid from `notBefore` to `notAfter`. */
export function makeCertificate(options: {
  commonName: string;
  altNames?: string[];
  notBefore: Date;
  notAfter: Date;
  organization?: string;
  ca?: boolean;
}): string {
  const keys = testKeypair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = createHash('sha256').update(`${options.commonName}${options.notAfter.toISOString()}`).digest('hex').slice(0, 16).replace(/^[89a-f]/, '1');
  cert.validity.notBefore = options.notBefore;
  cert.validity.notAfter = options.notAfter;
  const subject = [
    { name: 'commonName', value: options.commonName },
    { name: 'organizationName', value: options.organization ?? 'Example Test CA' },
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  const extensions: Record<string, unknown>[] = [{ name: 'basicConstraints', cA: options.ca === true }];
  if (options.altNames?.length) extensions.push({ name: 'subjectAltName', altNames: options.altNames.map((value) => ({ type: 2, value })) });
  cert.setExtensions(extensions);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

/** Values that must never appear in any report, export or prompt. */
export const SECRETS = {
  passwordHash: '$2b$12$PASSWORDHASHSENTINELabcdefghijklmnopqrstuvwxyz012345',
  accountPassword: '$2b$12$ACCOUNTPASSWORDSENTINELabcdefghijklmnopqrstuvwxy',
  rawApiToken: 'raw-api-token-SENTINEL-4f2a',
  sessionToken: 'session-token-SENTINEL-77c1',
  totpSecret: 'TOTPSECRETSENTINEL7Q',
  backupCodes: 'backup-codes-SENTINEL-19d0',
  oauthClientSecret: 'oauth-client-secret-SENTINEL-8e8e',
  oauthAccessToken: 'oauth-access-token-SENTINEL-2b2b',
  accessListHash: '$2b$12$ACCESSLISTHASHSENTINELabcdefghijklmnopqrstuvwxyz0',
  certificateKey: '-----BEGIN PRIVATE KEY-----\nCERT-KEY-SENTINEL-5a5a\n-----END PRIVATE KEY-----',
  caKey: '-----BEGIN PRIVATE KEY-----\nCA-KEY-SENTINEL-6b6b\n-----END PRIVATE KEY-----',
  dnsToken: 'dns-provider-token-SENTINEL-3c3c',
};

export const API_TOKEN_HASH = createHash('sha256').update(SECRETS.rawApiToken).digest('hex');

export type Seed = {
  now: Date;
  adminId: number;
  adminNoMfaId: number;
  inactiveId: number;
  disabledId: number;
  customId: number;
  roleId: number;
  groupId: number;
  importedCertId: number;
  expiredCertId: number;
  managedCertId: number;
  caId: number;
  hostWafId: number;
  hostOpenId: number;
  hostAuthId: number;
  hostAutoId: number;
  usedTokenId: number;
  unusedTokenId: number;
  expiredTokenId: number;
};

function iso(date: Date): string {
  return date.toISOString();
}

/** A small install covering every report. `now` is the reference time of the checks. */
export async function seedCompliance(db: TestDb, now: Date = new Date()): Promise<Seed> {
  const t = iso(now);
  const old = iso(new Date(now.getTime() - 200 * DAY));
  const recent = iso(new Date(now.getTime() - 2 * DAY));

  const insertUser = async (values: Partial<typeof schema.users.$inferInsert> & { email: string }) =>
    (await first(db.insert(schema.users).values({ role: 'user', status: 'active', createdAt: old, updatedAt: old, ...values }).returning()))!;

  const admin = await insertUser({ email: 'admin@example.com', name: 'Alice Admin', role: 'admin', twoFactorEnabled: true, passwordHash: SECRETS.passwordHash });
  await db.insert(schema.twoFactors).values({ userId: admin.id, secret: SECRETS.totpSecret, backupCodes: encryptSecret(SECRETS.backupCodes), verified: true });
  const adminNoMfa = await insertUser({ email: 'bob@example.com', name: 'Bob Admin', role: 'admin' });
  const inactive = await insertUser({ email: 'carol@example.com', name: 'Carol Viewer', role: 'viewer' });
  const disabled = await insertUser({ email: 'dave@example.com', name: 'Dave Disabled', role: 'user', status: 'disabled' });
  const role = (await first(db.insert(schema.customRoles).values({
    name: 'Team A', permissions: JSON.stringify(['proxy_hosts:read', 'proxy_hosts:write']), scopeTags: JSON.stringify(['team-a']), createdAt: t, updatedAt: t,
  }).returning()))!;
  const custom = await insertUser({ email: 'erin@example.com', name: 'Erin Operator', role: 'viewer', customRoleId: role.id, createdAt: recent });

  for (const user of [admin, adminNoMfa, inactive]) {
    await db.insert(schema.accounts).values({
      userId: user.id, accountId: String(user.id), providerId: 'credential', password: SECRETS.accountPassword, createdAt: old, updatedAt: old,
    });
  }
  await db.insert(schema.oauthProviders).values({
    id: 'corp-idp', name: 'Corporate IdP', clientId: 'client-id', clientSecret: encryptSecret(SECRETS.oauthClientSecret), createdAt: t, updatedAt: t,
  });
  await db.insert(schema.accounts).values({
    userId: custom.id, accountId: 'idp-subject-1', providerId: 'corp-idp', issuer: 'https://idp.example.com',
    accessToken: SECRETS.oauthAccessToken, createdAt: recent, updatedAt: recent,
  });
  await db.insert(schema.sessions).values({ userId: custom.id, token: SECRETS.sessionToken, expiresAt: iso(new Date(now.getTime() + DAY)), createdAt: recent, updatedAt: recent });

  // Sign-ins: Alice recently, Carol only long ago (inactive), Bob within 90 days.
  const signIn = async (userId: number, at: string) =>
    await db.insert(schema.auditEvents).values({ userId, action: 'login_success', entityType: 'session', summary: 'Signed in', createdAt: at });
  await signIn(admin.id, recent);
  await signIn(adminNoMfa.id, iso(new Date(now.getTime() - 30 * DAY)));
  await signIn(inactive.id, iso(new Date(now.getTime() - 150 * DAY)));

  const used = (await first(db.insert(schema.apiTokens).values({ name: 'ci deploy', tokenHash: API_TOKEN_HASH, createdBy: admin.id, createdAt: old, lastUsedAt: recent }).returning()))!;
  const unused = (await first(db.insert(schema.apiTokens).values({
    name: 'forgotten script', tokenHash: createHash('sha256').update('second').digest('hex'), createdBy: adminNoMfa.id, createdAt: old,
  }).returning()))!;
  const expiredToken = (await first(db.insert(schema.apiTokens).values({
    name: 'old token', tokenHash: createHash('sha256').update('third').digest('hex'), createdBy: admin.id, createdAt: old,
    expiresAt: iso(new Date(now.getTime() - 5 * DAY)),
  }).returning()))!;

  const group = (await first(db.insert(schema.groups).values({ name: 'Operators', createdAt: t, updatedAt: t }).returning()))!;
  await db.insert(schema.groupMembers).values({ groupId: group.id, userId: custom.id, createdAt: t });

  // Certificates.
  const pem = makeCertificate({
    commonName: 'app.example.com', altNames: ['app.example.com', '*.app.example.com'],
    notBefore: new Date(now.getTime() - 30 * DAY), notAfter: new Date(now.getTime() + 200 * DAY),
  });
  const imported = (await first(db.insert(schema.certificates).values({
    name: 'App certificate', type: 'imported', domainNames: JSON.stringify(['app.example.com']), autoRenew: false,
    certificatePem: pem, privateKeyPem: encryptSecret(SECRETS.certificateKey), createdAt: t, updatedAt: t,
  }).returning()))!;
  const expiredPem = makeCertificate({
    commonName: 'old.example.com', altNames: ['old.example.com'],
    notBefore: new Date(now.getTime() - 400 * DAY), notAfter: new Date(now.getTime() - 3 * DAY),
  });
  const expired = (await first(db.insert(schema.certificates).values({
    name: 'Old certificate', type: 'imported', domainNames: JSON.stringify(['old.example.com']), autoRenew: false,
    certificatePem: expiredPem, privateKeyPem: encryptSecret(SECRETS.certificateKey), createdAt: t, updatedAt: t,
  }).returning()))!;
  const managed = (await first(db.insert(schema.certificates).values({
    name: 'Managed wildcard', type: 'managed', domainNames: JSON.stringify(['*.example.org']), autoRenew: true,
    providerOptions: JSON.stringify({ provider: 'cloudflare' }), createdAt: t, updatedAt: t,
  }).returning()))!;
  const caPem = makeCertificate({
    commonName: 'Example Client CA', notBefore: new Date(now.getTime() - 10 * DAY), notAfter: new Date(now.getTime() + 20 * DAY), ca: true,
  });
  const ca = (await first(db.insert(schema.caCertificates).values({
    name: 'Client CA', certificatePem: caPem, privateKeyPem: encryptSecret(SECRETS.caKey), createdAt: t, updatedAt: t,
  }).returning()))!;
  const clientPem = makeCertificate({ commonName: 'laptop-1', notBefore: new Date(now.getTime() - 10 * DAY), notAfter: new Date(now.getTime() + 300 * DAY) });
  await db.insert(schema.issuedClientCertificates).values({
    caCertificateId: ca.id, commonName: 'laptop-1', serialNumber: '0A1B', fingerprintSha256: 'AA:BB', certificatePem: clientPem,
    validFrom: iso(new Date(now.getTime() - 10 * DAY)), validTo: iso(new Date(now.getTime() + 300 * DAY)), createdAt: t, updatedAt: t,
  });
  await db.insert(schema.issuedClientCertificates).values({
    caCertificateId: ca.id, commonName: 'stolen-phone', serialNumber: '0C1D', fingerprintSha256: 'CC:DD', certificatePem: clientPem,
    validFrom: iso(new Date(now.getTime() - 10 * DAY)), validTo: iso(new Date(now.getTime() + 300 * DAY)), revokedAt: recent, createdAt: t, updatedAt: t,
  });

  // Hosts.
  const list = (await first(db.insert(schema.accessLists).values({ name: 'Staff', createdAt: t, updatedAt: t }).returning()))!;
  await db.insert(schema.accessListEntries).values({ accessListId: list.id, username: 'staff', passwordHash: SECRETS.accessListHash, createdAt: t, updatedAt: t });
  const insertHost = async (values: Partial<typeof schema.proxyHosts.$inferInsert> & { name: string; domains: string }) =>
    (await first(db.insert(schema.proxyHosts).values({ upstreams: JSON.stringify(['http://app:8080']), createdAt: t, updatedAt: t, ...values }).returning()))!;
  const hostWaf = await insertHost({
    name: 'App', domains: JSON.stringify(['app.example.com']), certificateId: imported.id,
    meta: JSON.stringify({ waf: { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'override' } }),
  });
  const hostOpen = await insertHost({
    name: 'Legacy', domains: JSON.stringify(['legacy.example.com']), sslForced: false, hstsEnabled: false,
    upstreams: JSON.stringify(['https://legacy.internal:8443']), skipHttpsHostnameValidation: true,
  });
  const hostAuth = await insertHost({
    name: 'Admin panel', domains: JSON.stringify(['admin.example.com']), accessListId: list.id,
    meta: JSON.stringify({
      waf: { enabled: true, mode: 'Off', waf_mode: 'override' },
      cpm_forward_auth: { enabled: true },
      mtls: { enabled: true, trusted_client_cert_ids: [1] },
      geoblock: { enabled: true, block_countries: ['XX'], block_continents: [], block_asns: [], block_cidrs: [], block_ips: [], allow_countries: [], allow_continents: [], allow_asns: [], allow_cidrs: [], allow_ips: [], trusted_proxies: [], fail_closed: false, response_status: 403, response_body: 'Forbidden', response_headers: {}, redirect_url: '' },
      geoblock_mode: 'override',
    }),
  });
  await db.insert(schema.forwardAuthAccess).values({ proxyHostId: hostAuth.id, groupId: group.id, createdAt: t });
  const hostAuto = await insertHost({ name: 'Shop', domains: JSON.stringify(['shop.example.org']), enabled: false });

  // DNS provider credentials (must never appear).
  await db.insert(schema.settings).values({
    key: 'dns_provider', value: JSON.stringify({ providers: { cloudflare: { api_token: encryptSecret(SECRETS.dnsToken) } }, default: 'cloudflare' }), updatedAt: t,
  });

  return {
    now,
    adminId: admin.id,
    adminNoMfaId: adminNoMfa.id,
    inactiveId: inactive.id,
    disabledId: disabled.id,
    customId: custom.id,
    roleId: role.id,
    groupId: group.id,
    importedCertId: imported.id,
    expiredCertId: expired.id,
    managedCertId: managed.id,
    caId: ca.id,
    hostWafId: hostWaf.id,
    hostOpenId: hostOpen.id,
    hostAuthId: hostAuth.id,
    hostAutoId: hostAuto.id,
    usedTokenId: used.id,
    unusedTokenId: unused.id,
    expiredTokenId: expiredToken.id,
  };
}
