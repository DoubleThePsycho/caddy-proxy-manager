/**
 * Seeds the e2e stack with a believable but plainly synthetic install for the
 * website screenshots: proxy hosts on example.com and example.org, users and
 * groups with example.com addresses, access lists, alert rules, a compliance
 * evidence pack, a saved analytics question, and two weeks of traffic written
 * straight into ClickHouse (data.ts). Configuration goes through the REST API
 * (as the admin, or as other people with API tokens, so the audit log shows
 * several names); only sign-in history and second factors are written to the
 * database (db-seed.ts).
 *
 * Every step reports what failed instead of stopping, so one refused call
 * leaves a gap in a screenshot rather than no screenshots; seedAll() returns
 * the problems and the spec prints them.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { createClient } from '@clickhouse/client';
import forge from 'node-forge';
import { BURST_SQL, DAY, DETECTIONS_SQL, HOSTS, TRAFFIC_SQL, WAF_EVENTS_SQL, burstParams, ruleParams, trafficParams } from './data';
import { runInWeb, seedIdentities, type DbPerson } from './db-seed';

export const BASE = 'http://localhost:3000';
const ORIGIN = { Origin: BASE };
const PASSWORD = 'Shots-Example-2026!';

/** Where the development license key is read from: SHOTS_LICENSE_FILE, else tests/.auth/license.txt (git-ignored, removed by the teardown). */
export const LICENSE_FILE = process.env.SHOTS_LICENSE_FILE || resolve(__dirname, '../.auth/license.txt');

type Json = Record<string, any>;

export class Seeder {
  readonly problems: string[] = [];
  readonly ids: Record<string, number> = {};

  constructor(private readonly admin: APIRequestContext) {}

  /** One REST call; a failure is recorded (status and the start of the answer) and returns null. */
  async call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown, options: { as?: APIRequestContext; quiet?: boolean } = {}): Promise<Json | null> {
    const ctx = options.as ?? this.admin;
    const response = await ctx.fetch(`${BASE}${path}`, { method, headers: ORIGIN, data, failOnStatusCode: false, timeout: 120_000 });
    if (response.ok()) {
      const text = await response.text();
      try {
        return text ? (JSON.parse(text) as Json) : {};
      } catch {
        return {};
      }
    }
    // Never echo the body of the license call (the answer names the licensee).
    const body = options.quiet ? '' : (await response.text()).slice(0, 300);
    this.problems.push(`${method} ${path}: ${response.status()} ${body}`);
    return null;
  }

  async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.problems.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
}

// ── People ───────────────────────────────────────────────────────────────

type Person = DbPerson & { name: string; role?: 'admin' | 'user' | 'viewer'; customRole?: string; disabled?: boolean };

export const PEOPLE: Person[] = [
  { name: 'Giulia Romano', email: 'giulia.romano@example.com', role: 'admin', sources: ['password'], lastSignInHoursAgo: 2, lastSignInMethod: 'password', authenticatorApp: true },
  { name: 'Marco Bianchi', email: 'marco.bianchi@example.com', role: 'admin', sources: ['oidc'], lastSignInHoursAgo: 5, lastSignInMethod: 'passkey', passkeys: 2 },
  { name: 'Sara Conti', email: 'sara.conti@example.com', customRole: 'Shop operators', sources: ['oidc', 'scim'], lastSignInHoursAgo: 26, lastSignInMethod: 'sso' },
  { name: 'Luca Ferrari', email: 'luca.ferrari@example.com', role: 'user', sources: ['ldap'], lastSignInHoursAgo: 51, lastSignInMethod: 'ldap', authenticatorApp: true },
  { name: 'Elena Ricci', email: 'elena.ricci@example.com', role: 'viewer', sources: ['oidc', 'scim'], lastSignInHoursAgo: 98, lastSignInMethod: 'sso' },
  { name: 'Tom Becker', email: 'tom.becker@example.com', customRole: 'Auditors', sources: ['saml'], lastSignInHoursAgo: 290, lastSignInMethod: 'saml' },
  { name: 'Priya Shah', email: 'priya.shah@example.com', role: 'user', sources: ['password'], lastSignInHoursAgo: 960, lastSignInMethod: 'password' },
  { name: 'Nora Lindqvist', email: 'nora.lindqvist@example.com', role: 'viewer', sources: ['password'], lastSignInHoursAgo: null },
  { name: 'Jan Kowalski', email: 'jan.kowalski@example.com', role: 'user', sources: ['password'], lastSignInHoursAgo: 1500, lastSignInMethod: 'password', disabled: true },
  { name: 'Deploy pipeline', email: 'ci@example.com', role: 'user', sources: [], lastSignInHoursAgo: null },
];

const ADMIN_NAME = 'Alex Morgan';
const ADMIN_EMAIL = 'alex.morgan@example.com';

// ── Certificates ─────────────────────────────────────────────────────────

/** A self-signed certificate for `domains`, valid from 80 days ago until `daysLeft` days from now. */
function certificate(domains: string[], daysLeft: number): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomBytes(8).toString('hex').replace(/^[89a-f]/, '1');
  cert.validity.notBefore = new Date(Date.now() - 80 * DAY * 1000);
  cert.validity.notAfter = new Date(Date.now() + daysLeft * DAY * 1000);
  const subject = [{ name: 'commonName', value: domains[0] }, { name: 'organizationName', value: 'Example Corp' }];
  cert.setSubject(subject);
  cert.setIssuer([{ name: 'commonName', value: 'Example Corp Internal CA' }, { name: 'organizationName', value: 'Example Corp' }]);
  cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'subjectAltName', altNames: domains.map((value) => ({ type: 2, value })) }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

// ── ClickHouse ───────────────────────────────────────────────────────────

export function clickhouse() {
  return createClient({
    url: 'http://localhost:8123',
    username: 'ingressi',
    password: 'test-clickhouse-password-2026',
    database: 'analytics',
    request_timeout: 300_000,
  });
}

async function seedTraffic(seeder: Seeder): Promise<void> {
  const ch = clickhouse();
  try {
    // The web container creates the tables on start-up; wait for them.
    for (let i = 0; i < 60; i++) {
      const rows = await (await ch.query({ query: "SELECT count() AS n FROM system.tables WHERE database = 'analytics' AND name IN ('traffic_events', 'waf_events')", format: 'JSONEachRow' })).json<{ n: string }>();
      if (Number(rows[0]?.n) === 2) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    // A fresh picture on every run (this is the e2e stack's own ClickHouse).
    await ch.command({ query: 'TRUNCATE TABLE IF EXISTS traffic_events' });
    await ch.command({ query: 'TRUNCATE TABLE IF EXISTS waf_events' });
    const now = Math.floor(Date.now() / 1000);
    await ch.command({ query: TRAFFIC_SQL, query_params: { ...trafficParams(now), span: 15 * DAY, n: 2_500_000 } });
    await ch.command({ query: BURST_SQL, query_params: burstParams(now - 5 * 3600 - 20 * 60) });
    await ch.command({ query: WAF_EVENTS_SQL, query_params: ruleParams() });
    await ch.command({ query: DETECTIONS_SQL, query_params: ruleParams() });
    const counts = await (await ch.query({ query: 'SELECT (SELECT count() FROM traffic_events) AS traffic, (SELECT count() FROM waf_events) AS waf', format: 'JSONEachRow' })).json<{ traffic: string; waf: string }>();
    console.log(`[shots] traffic_events: ${counts[0]?.traffic}, waf_events: ${counts[0]?.waf}`);
  } catch (error) {
    seeder.problems.push(`ClickHouse: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  } finally {
    await ch.close();
  }
}

// ── The whole install ────────────────────────────────────────────────────

async function bearer(token: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

export async function seedAll(admin: APIRequestContext): Promise<Seeder> {
  const s = new Seeder(admin);

  await s.step('license', async () => {
    if (!existsSync(LICENSE_FILE)) {
      s.problems.push(`No license key at ${LICENSE_FILE}: paid screens show their unlicensed state`);
      return;
    }
    const key = readFileSync(LICENSE_FILE, 'utf8').trim();
    await s.call('PUT', '/api/v1/license', { key }, { quiet: true });
  });

  await s.step('basics', async () => {
    await s.call('PUT', '/api/v1/usage-ping', { enabled: false });
    await s.call('PUT', '/api/v1/setup-checklist', { dismissed: true });
    await s.call('PUT', '/api/v1/settings/logging', { enabled: true, format: 'json' });
    // An ACME directory that does not exist: the stack never asks a public CA for example.com certificates.
    await s.call('PUT', '/api/v1/settings/acme', { caUrl: 'https://acme.example.test/directory' });
    await s.call('PUT', '/api/v1/settings/waf', { enabled: true, mode: 'On', load_owasp_crs: true, custom_directives: '', paranoia_level: 1 });
    await s.call('PUT', '/api/v1/settings/geoblock', {
      enabled: true, fail_closed: false,
      block_countries: ['CN', 'RU', 'VN'], block_continents: [], block_asns: [64511], block_cidrs: [], block_ips: [],
      allow_countries: [], allow_continents: [], allow_asns: [], allow_cidrs: [], allow_ips: [],
      trusted_proxies: [], response_status: 403, response_body: 'Forbidden', response_headers: {}, redirect_url: '',
    });
    await s.call('PUT', '/api/v1/settings/rate-limit', {
      enabled: true,
      rules: [{ path: '/login', methods: ['POST'], key: 'client_ip', events: 10, window: '1m' }],
      allowlist: ['private_ranges'],
      ipv6Prefix: 64,
    });
  });

  // People, roles and groups.
  const userIds: Record<string, number> = {};
  await s.step('people', async () => {
    const list = ((await s.call('GET', '/api/v1/users')) ?? []) as Json[];
    const admin = list.find((u) => u.username === 'testadmin') ?? list.find((u) => u.role === 'admin');
    if (admin) {
      s.ids.admin = admin.id;
      await s.call('PUT', `/api/v1/users/${admin.id}`, { name: ADMIN_NAME });
      await s.call('PUT', `/api/v1/users/${admin.id}`, { email: ADMIN_EMAIL });
    }
    const roles: Record<string, number> = {};
    const shopRole = await s.call('POST', '/api/v1/roles', {
      name: 'Shop operators',
      description: 'Run the shop and its API: hosts, certificates and their traffic.',
      permissions: ['proxy_hosts:write', 'certificates:read', 'analytics:read', 'waf:read'],
      scopeTags: ['shop'],
    });
    if (shopRole) roles['Shop operators'] = shopRole.id;
    const auditRole = await s.call('POST', '/api/v1/roles', {
      name: 'Auditors',
      description: 'Read the audit log and the compliance evidence, change nothing.',
      permissions: ['audit_log:read', 'compliance:read', 'analytics:read', 'proxy_hosts:read', 'certificates:read'],
    });
    if (auditRole) roles.Auditors = auditRole.id;
    for (const person of PEOPLE) {
      const created = await s.call('POST', '/api/v1/users', {
        email: person.email,
        name: person.name,
        password: PASSWORD,
        ...(person.customRole && roles[person.customRole] ? { customRoleId: roles[person.customRole] } : { role: person.role ?? 'user' }),
      });
      if (created) userIds[person.email] = created.id;
    }
  });

  const tokens = { giulia: `shots-${randomBytes(16).toString('hex')}`, marco: `shots-${randomBytes(16).toString('hex')}`, ci: `shots-${randomBytes(16).toString('hex')}` };
  await s.step('identities', async () => {
    const out = seedIdentities({
      oidcName: 'Corporate SSO',
      samlName: 'Contractor IdP',
      ldapName: 'Active Directory',
      // The admin who takes the screenshots has an authenticator app too.
      people: [...PEOPLE, { email: ADMIN_EMAIL, sources: ['password'], lastSignInHoursAgo: null, authenticatorApp: true }],
      providerSignIns: [
        { kind: 'oidc', email: 'marco.bianchi@example.com', hoursAgo: 5 },
        { kind: 'ldap', email: 'luca.ferrari@example.com', hoursAgo: 51 },
        { kind: 'saml', email: 'tom.becker@example.com', hoursAgo: 290 },
      ],
      tokens: [
        { email: 'giulia.romano@example.com', name: 'Giulia (automation)', token: tokens.giulia, lastUsedHoursAgo: 1 },
        { email: 'marco.bianchi@example.com', name: 'Marco (terraform)', token: tokens.marco, lastUsedHoursAgo: 3 },
        { email: 'ci@example.com', name: 'Release pipeline', token: tokens.ci, lastUsedHoursAgo: 4 },
      ],
    });
    if (!out.includes('ok')) s.problems.push(`identities: ${out.slice(0, 300)}`);
    // Every administrator who signs in with a password has a second factor by now.
    await s.call('PUT', '/api/v1/mfa/policy', { scope: 'admins', graceDays: 14 });
  });

  // A nightly backup that last ran a few hours ago (the scheduler's next run is a day away, so nothing is ever sent).
  await s.step('backups', async () => {
    const out = runInWeb(String.raw`
import { Database } from "bun:sqlite";
const db = new Database("./data/ingressi.db");
db.run("PRAGMA busy_timeout = 10000");
const at = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
if (!db.query("SELECT id FROM backup_destinations WHERE name = ?").get("Nightly to object storage")) {
  db.run("INSERT INTO backup_destinations (name, enabled, endpoint, region, bucket, keyPrefix, pathStyle, accessKeyId, secretAccessKey, passphrase, schedule, timeZone, retention, nextRunAt, lastRunAt, lastStatus, lastSuccessAt, consecutiveFailures, createdAt, updatedAt) VALUES (?, 1, 'https://s3.example.com', 'eu-south-1', 'ingressi-backups', 'nightly', 0, 'unused', 'unused', 'unused', ?, 'Europe/Rome', 30, ?, ?, 'success', ?, 0, ?, ?)",
    ["Nightly to object storage", JSON.stringify({ kind: "daily", time: "03:00" }), at(22), at(-2), at(-2), at(-24 * 60), at(-24 * 60)]);
}
console.log("ok");
`, {});
    if (!out.includes('ok')) s.problems.push(`backups: ${out.slice(0, 300)}`);
  });

  const giulia = await bearer(tokens.giulia);
  const marco = await bearer(tokens.marco);

  const groupIds: Record<string, number> = {};
  await s.step('groups', async () => {
    const groups: [string, string, string[]][] = [
      ['Shop team', 'People who run the shop and its API.', ['giulia.romano@example.com', 'sara.conti@example.com', 'marco.bianchi@example.com']],
      ['Customer support', 'Reach the customer portal and the CRM.', ['elena.ricci@example.com', 'priya.shah@example.com']],
      ['Contractors', 'External people with limited access.', ['tom.becker@example.com']],
    ];
    for (const [name, description, members] of groups) {
      const group = await s.call('POST', '/api/v1/groups', { name, description }, { as: giulia });
      if (!group) continue;
      groupIds[name] = group.id;
      for (const email of members) {
        if (userIds[email]) await s.call('POST', `/api/v1/groups/${group.id}/members`, { userId: userIds[email] }, { as: giulia });
      }
    }
  });

  // Access lists and certificates.
  await s.step('access lists', async () => {
    const office = await s.call('POST', '/api/v1/access-lists', {
      name: 'Office and VPN',
      description: 'Head office and the VPN; everyone else is refused.',
      rules: [
        { action: 'allow', kind: 'ip', values: ['198.51.100.0/26'], note: 'Head office' },
        { action: 'allow', kind: 'ip', values: ['2001:db8:4f00::/40'], note: 'VPN' },
      ],
      defaultAction: 'deny',
      denyStatus: 403,
    }, { as: giulia });
    if (office) s.ids.officeList = office.id;
    const partners = await s.call('POST', '/api/v1/access-lists', {
      name: 'Partner API',
      description: 'Basic auth for the partners that still use the old CRM.',
      users: [{ username: 'partner-north', password: 'Example-Partner-1!' }, { username: 'partner-south', password: 'Example-Partner-2!' }],
      rules: [{ action: 'deny', kind: 'country', values: ['CN', 'RU'], note: 'Not served' }],
      defaultAction: 'allow',
    });
    if (partners) s.ids.partnerList = partners.id;
    await s.call('POST', '/api/v1/access-lists/blocked-sources/entries', { kind: 'asn', value: '64511', reason: 'Example VPS: scanners only' });
  });

  // Certificates from the company's own CA: the stack never orders any from a public CA.
  await s.step('certificates', async () => {
    const certificates: [string, string, string[], number][] = [
      ['comCertificate', 'Wildcard example.com', ['example.com', '*.example.com', '*.shop.example.com'], 214],
      ['orgCertificate', 'Wildcard example.org', ['example.org', '*.example.org'], 167],
      ['crmCertificate', 'Legacy CRM', ['crm.example.org'], 9],
    ];
    for (const [id, name, domainNames, daysLeft] of certificates) {
      const { cert, key } = certificate(domainNames, daysLeft);
      const created = await s.call('POST', '/api/v1/certificates', { name, type: 'imported', domainNames, certificatePem: cert, privateKeyPem: key });
      if (created) s.ids[id] = created.id;
    }
  });

  // Proxy hosts.
  await s.step('proxy hosts', async () => {
    const extra: Record<string, Json> = {
      shop: {
        loadBalancer: { enabled: true, policy: 'least_conn', retries: 2, tryDuration: '5s', passiveHealthCheck: { enabled: true, failDuration: '30s', maxFails: 3, unhealthyStatus: [502, 503, 504] } },
        waf: { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'merge' },
        rateLimit: { enabled: true, mode: 'merge', rules: [
          { path: '/checkout*', methods: ['POST'], key: 'client_ip', events: 20, window: '1m' },
          { path: '/search*', key: 'client_ip', events: 120, window: '1m' },
        ] },
        hstsEnabled: true,
        hstsSubdomains: true,
      },
      api: {
        loadBalancer: { enabled: true, policy: 'round_robin', retries: 1, passiveHealthCheck: { enabled: true, failDuration: '30s', maxFails: 5, unhealthyStatus: [502, 503] } },
        waf: { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'merge' },
        rateLimit: { enabled: true, mode: 'merge', rules: [
          { path: '/v2/*', key: 'header', header: 'X-Api-Key', events: 600, window: '1m' },
          { path: '/v2/auth/token', methods: ['POST'], key: 'client_ip', events: 10, window: '1m' },
        ] },
      },
      www: { waf: { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'merge' } },
      docs: { waf: { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'merge' } },
      portal: { ingressiForwardAuth: { enabled: true } },
      hooks: { rateLimit: { enabled: true, mode: 'merge', rules: [{ path: '*', methods: ['POST'], key: 'client_ip', events: 300, window: '1m' }] } },
      grafana: { accessListId: s.ids.officeList ?? null },
      crm: { accessListId: s.ids.partnerList ?? null, certificateId: s.ids.crmCertificate ?? null },
    };
    // Who creates what: the audit log's recent changes then name several people.
    const by: Record<string, APIRequestContext | undefined> = { grafana: marco, status: marco, hooks: giulia, docs: giulia };
    for (const host of HOSTS) {
      const certificateId = host.domains[0].endsWith('.example.org') ? s.ids.orgCertificate : s.ids.comCertificate;
      const created = await s.call('POST', '/api/v1/proxy-hosts', {
        name: host.name,
        domains: host.domains,
        upstreams: host.upstreams,
        tags: host.tags,
        certificateId: certificateId ?? null,
        ...(extra[host.key] ?? {}),
      }, { as: by[host.key] });
      if (created) s.ids[`host:${host.key}`] = created.id;
    }
    if (s.ids['host:portal'] && groupIds['Customer support']) {
      await s.call('PUT', `/api/v1/proxy-hosts/${s.ids['host:portal']}/forward-auth-access`, { userIds: [], groupIds: [groupIds['Customer support'], groupIds['Shop team']].filter(Boolean) });
    }
  });

  // Alerts.
  await s.step('alerts', async () => {
    const channel = await s.call('POST', '/api/v1/alert-channels', {
      name: 'Ops on-call',
      type: 'email',
      config: { host: 'smtp.example.com', port: 587, secure: false, from: 'ingressi@example.com', to: ['ops@example.com'] },
    });
    const hook = await s.call('POST', '/api/v1/alert-channels', { name: 'Incident webhook', type: 'webhook', config: { url: 'https://hooks.example.com/incidents' } });
    const channelIds = [channel?.id, hook?.id].filter(Boolean);
    await s.call('POST', '/api/v1/alert-rules', { name: 'Certificates expiring', type: 'cert_expiring', params: { days: 7 }, channelIds, cooldownMinutes: 1440 });
    await s.call('POST', '/api/v1/alert-rules', { name: 'WAF spike on the shop', type: 'waf_spike', params: { threshold: 2000, windowMinutes: 10 }, channelIds, scope: { type: 'hosts', proxyHostIds: [s.ids['host:shop'], s.ids['host:api']].filter(Boolean) } });
    await s.call('POST', '/api/v1/alert-rules', { name: 'API errors', type: 'error_rate', params: { thresholdPercent: 25, windowMinutes: 10, minRequests: 200, perHost: true }, channelIds });
  }, );

  // AI analyst: a provider that is never called (answers to saved questions are computed here).
  // Giulia's saved questions are her own, so the admin's Ask box stays compact.
  await s.step('ai', async () => {
    await s.call('PUT', '/api/v1/ai/settings', { provider: 'openai_compatible', baseUrl: 'http://llm.example.test:11434/v1', model: 'llama3.1:8b', enabled: true });
    await s.call('PUT', '/api/v1/ai/question-settings', { enabled: true, aiSummaries: false, shareRequestDetails: false });
    const saved = await s.call('POST', '/api/v1/analytics/questions/saved', {
      question: 'Which countries were blocked most this week on the shop hosts?',
      query: { metric: 'mitigated', breakdown: 'country', hostTags: ['shop'], range: { preset: '7d' }, comparison: 'previous_period', limit: 10 },
    }, { as: giulia });
    if (saved) s.ids.savedQuestion = saved.id;
    await s.call('POST', '/api/v1/analytics/questions/saved', {
      question: 'Did 5xx errors on the API go up compared with last week?',
      query: { metric: 'errors', breakdown: 'time', filters: [{ dim: 'host', op: 'is', value: 'api.example.com' }, { dim: 'status', op: 'is', value: '5xx' }], range: { preset: '7d' }, comparison: 'previous_period' },
    }, { as: giulia });
  });

  await seedTraffic(s);

  // Compliance: an access review, a restore test, a verified audit chain and an evidence pack.
  await s.step('compliance', async () => {
    const reviewers = [s.ids.admin, userIds['giulia.romano@example.com']].filter(Boolean);
    const campaign = await s.call('POST', '/api/v1/access-reviews', { name: 'Q3 access review', scope: { type: 'all' }, reviewerIds: reviewers, dueAt: new Date(Date.now() + 14 * DAY * 1000).toISOString() });
    if (campaign) await s.call('POST', `/api/v1/access-reviews/${campaign.id}/complete`, {});
    await s.call('POST', '/api/v1/compliance/restore-tests', { testedAt: new Date(Date.now() - 12 * DAY * 1000).toISOString(), source: 'backup', outcome: 'success', notes: 'Restored last night\'s backup on a spare VM; every host answered.' });
    await s.call('GET', '/api/v1/audit-log/verify');
    const schedule = await s.call('POST', '/api/v1/compliance/schedules', {
      name: 'Monthly NIS2 evidence',
      frequency: 'monthly',
      dayOfMonth: 1,
      time: '06:00',
      timeZone: 'Europe/Rome',
      reportTypes: ['access_review', 'change_log', 'certificate_inventory', 'protection_coverage'],
      ...(s.ids.savedQuestion ? { questionIds: [s.ids.savedQuestion] } : {}),
    }, { as: giulia });
    if (schedule) await s.call('POST', `/api/v1/compliance/schedules/${schedule.id}/run`, {}, { as: giulia });
    await s.call('POST', '/api/v1/compliance/incidents', {
      title: 'SQL injection attempts against the shop',
      detectedAt: new Date(Date.now() - 4.5 * 3600 * 1000).toISOString(),
      classification: 'not_significant',
      cause: 'Automated SQL injection and XSS probes from four addresses; all blocked by the WAF.',
      proxyHostIds: [s.ids['host:shop'], s.ids['host:api']].filter(Boolean),
    });
  });

  // Backdate the completed review so it reads like last month's.
  await s.step('backdate', async () => {
    runInWeb(String.raw`
import { Database } from "bun:sqlite";
const db = new Database("./data/ingressi.db");
db.run("PRAGMA busy_timeout = 10000");
const started = new Date(Date.now() - 34 * 86400000).toISOString();
const done = new Date(Date.now() - 23 * 86400000).toISOString();
db.run("UPDATE access_review_campaigns SET startedAt = ?, completedAt = ? WHERE status = 'completed'", [started, done]);
console.log("ok");
`, {});
  });

  // Users disabled last (an API call as them would fail afterwards).
  await s.step('disable', async () => {
    for (const person of PEOPLE.filter((p) => p.disabled)) {
      if (userIds[person.email]) await s.call('PUT', `/api/v1/users/${userIds[person.email]}`, { status: 'disabled' });
    }
  });

  // The latest changes: what the overview's recent changes show first.
  await s.step('latest changes', async () => {
    if (s.ids.officeList) {
      await s.call('POST', `/api/v1/access-lists/${s.ids.officeList}/rules`, { action: 'allow', kind: 'ip', values: ['192.0.2.224/28'], note: 'Branch office' }, { as: marco });
    }
    await s.call('POST', '/api/v1/access-lists/blocked-sources/entries', { address: '203.0.113.240', reason: 'SQL injection burst against the shop', expiresInSeconds: 7 * DAY }, { as: giulia });
    await s.call('POST', '/api/v1/access-lists/blocked-sources/entries', { address: '203.0.113.241', reason: 'SQL injection burst against the shop', expiresInSeconds: 7 * DAY }, { as: giulia });
  });

  await giulia.dispose();
  await marco.dispose();
  return s;
}
