/**
 * Alerting additions: the error rate rule (ClickHouse traffic read through an
 * injected reader), certificates Caddy manages in the certificate expiry rule,
 * rule scopes and "for" durations (validation, license, engine), firing
 * alerts and episode ends.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

import * as schema from '../../src/lib/db/schema';
import { evaluateCertExpiring, evaluateErrorRate, matchRequestHost, type Evaluation, type Finding, type TrafficReader } from '../../ee/alerting/evaluators';
import { createAlertRule, describeRuleScope, getAlertRule, listAlertRules, updateAlertRule } from '../../ee/alerting/rules';
import { runAlertEvaluation, type EngineDependencies } from '../../ee/alerting/engine';
import { lastFiredAtByRule, listAlertEvents, listFiringAlerts } from '../../ee/alerting/events';
import { LicenseRequiredError } from '../../ee/licensing/store';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { installLicense, licenseSigner } from '../helpers/config-fixture';
import type { ManagedCertificateReport, ManagedCertificateStatus } from '../../src/lib/managed-certificates';

const T0 = new Date('2026-10-03T09:05:00.000Z');
const DAY = 86_400_000;
const stamp = () => new Date().toISOString();

beforeEach(async () => {
  for (const table of [schema.alertEvents, schema.alertRuleStates, schema.alertRules, schema.alertChannels, schema.proxyHosts, schema.settings]) {
    await ctx.db.delete(table);
  }
  setTrustedLicenseKeysForTests(licenseSigner.keys);
});

afterAll(() => setTrustedLicenseKeysForTests(null));

async function addHost(name: string, domains: string[], values: Partial<typeof schema.proxyHosts.$inferInsert> = {}): Promise<number> {
  const [row] = await ctx.db
    .insert(schema.proxyHosts)
    .values({ name, domains: JSON.stringify(domains), upstreams: '["backend:80"]', createdAt: stamp(), updatedAt: stamp(), ...values })
    .returning();
  return row.id;
}

function reader(rows: { host: string; requests: number; errors5xx: number }[], options: { enabled?: boolean; fail?: boolean } = {}): TrafficReader & { breakdownHosts: string[][] } {
  const breakdownHosts: string[][] = [];
  return {
    breakdownHosts,
    analyticsEnabled: () => options.enabled ?? true,
    hostErrorCounts: vi.fn(async () => {
      if (options.fail) throw new Error('ClickHouse down');
      return rows;
    }),
    errorBreakdown: vi.fn(async (_from: number, _to: number, hosts: string[]) => {
      breakdownHosts.push(hosts);
      return [{ status: 501, method: 'POST', path: '/Microsoft-Server-ActiveSync', count: 143, firstAt: '2026-10-03T09:01:57.000Z', lastAt: '2026-10-03T09:03:11.000Z' }];
    }),
  };
}

const params = { thresholdPercent: 1, windowMinutes: 1, minRequests: 20, perHost: true };

describe('error_rate', () => {
  it('fires per proxy host above the threshold, with enough requests, matching wildcards', async () => {
    const mail = await addHost('Mail', ['email.example.com']);
    const wild = await addHost('Apps', ['*.apps.example.com']);
    await addHost('Quiet', ['quiet.example.com']);
    await addHost('Off', ['off.example.com'], { enabled: false });
    const traffic = reader([
      { host: 'email.example.com', requests: 2729, errors5xx: 143 },
      { host: 'one.apps.example.com', requests: 50, errors5xx: 1 },
      { host: 'two.apps.example.com', requests: 50, errors5xx: 0 },
      { host: 'quiet.example.com', requests: 10, errors5xx: 10 },
      { host: 'off.example.com', requests: 500, errors5xx: 500 },
      { host: 'unknown.example.net', requests: 500, errors5xx: 500 },
    ]);
    const result = await evaluateErrorRate(params, T0, { type: 'all' }, traffic);
    expect(result.status).toBe('ok');
    const findings = result.status === 'ok' ? result.findings : [];
    // Mail: 5.2% > 1%. Apps: 1 of 100 = 1%, not above. Quiet: under minRequests. Off: disabled. Unknown host: no proxy host.
    expect(findings.map((item) => item.subjectKey)).toEqual([`proxy_host:${mail}`]);
    expect(findings[0]).toMatchObject({
      severity: 'critical',
      title: '5xx responses at 5.2% on "Mail" (143 of 2729 requests in 1 minute)',
      facts: { proxyHost: 'Mail', requests: 2729, errors5xx: 143, ratePercent: 5.24, thresholdPercent: 1, topErrors: [{ status: 501, path: '/Microsoft-Server-ActiveSync' }] },
    });
    expect(findings[0].message).toContain('The most frequent was status 501');
    // Request-derived text (paths) stays out of the message.
    expect(findings[0].message).not.toContain('ActiveSync');
    expect(traffic.breakdownHosts).toEqual([['email.example.com']]);
    expect(wild).toBeGreaterThan(0);
  });

  it('adds the hosts in scope together when perHost is off', async () => {
    const a = await addHost('A', ['a.example.com']);
    await addHost('B', ['b.example.com']);
    const traffic = reader([
      { host: 'a.example.com', requests: 100, errors5xx: 3 },
      { host: 'b.example.com', requests: 100, errors5xx: 3 },
    ]);
    const all = await evaluateErrorRate({ ...params, thresholdPercent: 2.5, perHost: false }, T0, { type: 'all' }, traffic);
    expect(all.status === 'ok' && all.findings.map((item) => [item.subjectKey, item.facts.requests])).toEqual([['hosts', 200]]);
    const scoped = await evaluateErrorRate({ ...params, thresholdPercent: 2.5, perHost: false }, T0, { type: 'hosts', proxyHostIds: [a] }, traffic);
    expect(scoped.status === 'ok' && scoped.findings.map((item) => item.facts.requests)).toEqual([100]);
    expect(scoped.status === 'ok' && scoped.findings[0].title).toContain("the rule's 1 chosen proxy host");
  });

  it('is skipped without ClickHouse or when it cannot be queried, so nothing resolves by mistake', async () => {
    expect(await evaluateErrorRate(params, T0, { type: 'all' }, reader([], { enabled: false }))).toEqual({ status: 'skipped', reason: 'ClickHouse analytics is not configured' });
    expect(await evaluateErrorRate(params, T0, { type: 'all' }, reader([], { fail: true }))).toEqual({ status: 'skipped', reason: 'ClickHouse could not be queried' });
  });

  it('matches request hosts to proxy hosts exactly first, then by wildcard', () => {
    const hosts = [
      { id: 1, name: 'Wild', domains: ['*.example.com'], upstreams: [], certificateId: null },
      { id: 2, name: 'Exact', domains: ['www.example.com'], upstreams: [], certificateId: null },
    ];
    expect(matchRequestHost('WWW.example.com:443', hosts)?.id).toBe(2);
    expect(matchRequestHost('api.example.com', hosts)?.id).toBe(1);
    expect(matchRequestHost('a.b.example.com', hosts)).toBeNull();
  });
});

function managedStatus(overrides: Partial<ManagedCertificateStatus>): ManagedCertificateStatus {
  return {
    domain: 'auth.example.com',
    servername: 'auth.example.com',
    proxyHosts: [{ id: 1, name: 'Auth' }],
    changedAt: '2026-01-01T00:00:00.000Z',
    state: 'valid',
    validFrom: new Date(T0.getTime() - 59 * DAY).toISOString(),
    validTo: new Date(T0.getTime() + 31 * DAY).toISOString(),
    daysLeft: 31,
    renewsAt: new Date(T0.getTime() + DAY).toISOString(),
    issuer: "Let's Encrypt",
    fingerprint256: 'AA',
    error: null,
    checkedAt: T0.toISOString(),
    ...overrides,
  };
}

function managed(certificates: ManagedCertificateStatus[], available = true): { managedCertificates: () => Promise<ManagedCertificateReport> } {
  return { managedCertificates: async () => ({ available, reason: available ? null : 'unreachable', certificates, unchecked: 0 }) };
}

const certParams = { days: 35, includeClientCertificates: false, includeManagedCertificates: true };

describe('cert_expiring with certificates Caddy manages', () => {
  it('fires for certificates within the window and for overdue renewals, missing and mismatched certificates', async () => {
    const result = await evaluateCertExpiring(certParams, T0, { type: 'all' }, managed([
      managedStatus({}),
      managedStatus({ domain: 'late.example.com', servername: 'late.example.com', state: 'renewal_overdue', daysLeft: 5, validTo: new Date(T0.getTime() + 5 * DAY).toISOString() }),
      managedStatus({ domain: 'gone.example.com', servername: 'gone.example.com', state: 'missing', validTo: null, daysLeft: null }),
      managedStatus({ domain: 'wrong.example.com', servername: 'wrong.example.com', state: 'mismatch' }),
      managedStatus({ domain: 'far.example.com', servername: 'far.example.com', daysLeft: 80, validTo: new Date(T0.getTime() + 80 * DAY).toISOString() }),
    ]));
    expect(result.status).toBe('ok');
    const byKey = new Map((result.status === 'ok' ? result.findings : []).map((item: Finding) => [item.subjectKey, item]));
    expect([...byKey.keys()].sort()).toEqual([
      'managed_certificate:auth.example.com',
      'managed_certificate:gone.example.com',
      'managed_certificate:late.example.com',
      'managed_certificate:wrong.example.com',
    ]);
    expect(byKey.get('managed_certificate:auth.example.com')).toMatchObject({ severity: 'warning', title: 'Certificate for auth.example.com expires in 31 days (on 2026-11-03)' });
    expect(byKey.get('managed_certificate:auth.example.com')!.message).toContain("Caddy manages for auth.example.com, used by \"Auth\"");
    expect(byKey.get('managed_certificate:late.example.com')).toMatchObject({ severity: 'critical', title: expect.stringMatching(/^Renewal of the certificate for late\.example\.com is overdue/) });
    expect(byKey.get('managed_certificate:gone.example.com')).toMatchObject({ severity: 'critical', title: 'Caddy has no certificate for gone.example.com' });
    expect(byKey.get('managed_certificate:wrong.example.com')).toMatchObject({ severity: 'warning' });
  });

  it('keeps what it cannot tell about: Caddy unreachable, a TLS error, or a host saved a moment ago', async () => {
    const unreachable = await evaluateCertExpiring(certParams, T0, { type: 'all' }, managed([], false));
    expect(unreachable).toMatchObject({ status: 'ok', findings: [], preservePrefixes: ['managed_certificate:'] });

    const unsure = await evaluateCertExpiring(certParams, T0, { type: 'all' }, managed([
      managedStatus({ state: 'error', error: 'The TLS handshake failed (ERR_SSL)' }),
      managedStatus({ domain: 'new.example.com', servername: 'new.example.com', state: 'missing', changedAt: new Date(T0.getTime() - 60_000).toISOString() }),
    ]));
    expect(unsure).toMatchObject({ status: 'ok', findings: [], preserveKeys: ['managed_certificate:auth.example.com', 'managed_certificate:new.example.com'] });
  });

  it('limits a scoped rule to the certificates of its hosts', async () => {
    const auth = await addHost('Auth', ['auth.example.com']);
    const other = await addHost('Other', ['other.example.com']);
    const result = await evaluateCertExpiring(certParams, T0, { type: 'hosts', proxyHostIds: [auth] }, managed([
      managedStatus({ proxyHosts: [{ id: auth, name: 'Auth' }] }),
      managedStatus({ domain: 'other.example.com', servername: 'other.example.com', proxyHosts: [{ id: other, name: 'Other' }] }),
    ]));
    expect(result.status === 'ok' && result.findings.map((item) => item.subjectKey)).toEqual(['managed_certificate:auth.example.com']);
  });

  it('is left out when includeManagedCertificates is false', async () => {
    const result = await evaluateCertExpiring({ ...certParams, includeManagedCertificates: false }, T0, { type: 'all' }, managed([managedStatus({})]));
    expect(result).toMatchObject({ status: 'ok', findings: [] });
  });
});

describe('rules: scope and "for" duration', () => {
  it('needs the alerting feature for error rate rules', async () => {
    await expect(createAlertRule({ name: '5xx', type: 'error_rate' }, 1)).rejects.toBeInstanceOf(LicenseRequiredError);
    await installLicense(ctx.db);
    const rule = await createAlertRule({ name: '5xx', type: 'error_rate', forMinutes: 2 }, 1);
    expect(rule).toMatchObject({
      type: 'error_rate',
      params: { thresholdPercent: 5, windowMinutes: 5, minRequests: 20, perHost: true },
      scope: { type: 'all' },
      scopeLabel: 'Each proxy host',
      forMinutes: 2,
      pending: [],
    });
  });

  it('validates scopes and durations', async () => {
    await installLicense(ctx.db);
    const host = await addHost('App', ['app.example.com']);
    const scoped = await createAlertRule({ name: 'Upstreams', type: 'upstream_down', scope: { type: 'hosts', proxyHostIds: [host, host] } }, 1);
    expect(scoped).toMatchObject({ scope: { type: 'hosts', proxyHostIds: [host] }, scopeLabel: 'Upstreams of 1 proxy host' });

    await expect(createAlertRule({ name: 'x', type: 'caddy_apply_failed', scope: { type: 'hosts', proxyHostIds: [host] } }, 1)).rejects.toThrow(/cannot be limited to chosen hosts/);
    await expect(createAlertRule({ name: 'x', type: 'upstream_down', scope: { type: 'hosts', proxyHostIds: [999] } }, 1)).rejects.toThrow(/proxy host 999 does not exist/);
    await expect(createAlertRule({ name: 'x', type: 'upstream_down', scope: { type: 'hosts', proxyHostIds: [] } }, 1)).rejects.toThrow(/at least one/);
    await expect(createAlertRule({ name: 'x', type: 'upstream_down', scope: { type: 'some' } }, 1)).rejects.toThrow(/scope.type/);
    await expect(createAlertRule({ name: 'x', type: 'approval_pending', forMinutes: 5 }, 1)).rejects.toThrow(/fires at once/);
    await expect(createAlertRule({ name: 'x', type: 'upstream_down', forMinutes: 99999 }, 1)).rejects.toThrow(/forMinutes/);
    await expect(createAlertRule({ name: 'x', type: 'error_rate', params: { thresholdPercent: 0 } }, 1)).rejects.toThrow(/thresholdPercent/);
    await expect(createAlertRule({ name: 'x', type: 'error_rate', params: { thresholdPercent: 'a' } }, 1)).rejects.toThrow(/thresholdPercent/);

    const updated = await updateAlertRule(scoped.id, { scope: { type: 'all' }, forMinutes: 3 }, 1);
    expect(updated).toMatchObject({ scope: { type: 'all' }, forMinutes: 3, scopeLabel: 'Every upstream with passive health checks' });
  });

  it('describes what each rule watches', () => {
    expect(describeRuleScope('error_rate', { type: 'hosts', proxyHostIds: [1, 2] }, { perHost: false })).toBe('2 proxy hosts together');
    expect(describeRuleScope('cert_expiring', { type: 'all' }, { includeClientCertificates: false })).toBe('All certificates');
    expect(describeRuleScope('caddy_apply_failed', { type: 'all' }, {})).toBe('This node');
  });
});

describe('engine: "for" duration and preserved subjects', () => {
  function finding(subjectKey: string): Finding {
    return { subjectKey, label: `${subjectKey} failing`, title: `${subjectKey} is failing`, message: 'm', severity: 'critical', facts: {} };
  }

  async function addRule(values: Partial<typeof schema.alertRules.$inferInsert> = {}): Promise<number> {
    const [row] = await ctx.db
      .insert(schema.alertRules)
      .values({ name: 'Upstreams', type: 'upstream_down', params: '{"minFails":1}', channelIds: '[]', createdAt: stamp(), updatedAt: stamp(), ...values })
      .returning();
    return row.id;
  }

  function harness() {
    let current: Evaluation = { status: 'ok', findings: [] };
    const deps: EngineDependencies = {
      evaluate: vi.fn(async () => current),
      deliver: vi.fn(async () => ({ ok: true as const, error: null })),
      explain: vi.fn(async () => null),
    };
    return {
      set: (evaluation: Evaluation) => { current = evaluation; },
      run: (at: Date) => runAlertEvaluation({ now: at, ...deps }),
    };
  }

  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

  it('fires only after the condition held for forMinutes, and forgets a condition that cleared before', async () => {
    const ruleId = await addRule({ forMinutes: 3 });
    const h = harness();
    h.set({ status: 'ok', findings: [finding('a')] });
    expect(await h.run(at(0))).toMatchObject({ fired: 0 });
    expect((await getAlertRule(ruleId))!.pending).toEqual([{ subjectKey: 'a', title: 'a failing', since: at(0).toISOString() }]);
    expect(await h.run(at(2))).toMatchObject({ fired: 0 });
    expect(await h.run(at(3))).toMatchObject({ fired: 1 });
    expect((await getAlertRule(ruleId))!).toMatchObject({ pending: [], firing: [{ subjectKey: 'a' }] });

    // A second subject clears before its duration: no event at all.
    h.set({ status: 'ok', findings: [finding('a'), finding('b')] });
    await h.run(at(4));
    h.set({ status: 'ok', findings: [finding('a')] });
    expect(await h.run(at(5))).toMatchObject({ fired: 0, resolved: 0 });
    const events = await ctx.db.select().from(schema.alertEvents);
    expect(events.map((event) => [event.subjectKey, event.status])).toEqual([['a', 'firing']]);
    expect((await getAlertRule(ruleId))!.pending).toEqual([]);
  });

  it('reports when each rule last fired', async () => {
    const ruleId = await addRule();
    // Disabled rules are not evaluated: this one never fires.
    const quiet = await addRule({ name: 'Quiet', enabled: false });
    const h = harness();
    expect((await getAlertRule(ruleId))!.lastFiredAt).toBeNull();
    h.set({ status: 'ok', findings: [finding('a')] });
    await h.run(at(0));
    h.set({ status: 'ok', findings: [] });
    await h.run(at(1));
    h.set({ status: 'ok', findings: [finding('b')] });
    await h.run(at(2));
    // The newest firing event, not the resolve in between.
    expect((await getAlertRule(ruleId))!.lastFiredAt).toBe(at(2).toISOString());
    const listed = await listAlertRules();
    expect(listed.find((rule) => rule.id === ruleId)!.lastFiredAt).toBe(at(2).toISOString());
    expect(listed.find((rule) => rule.id === quiet)!.lastFiredAt).toBeNull();
    expect([...(await lastFiredAtByRule([quiet])).entries()]).toEqual([]);
    expect((await lastFiredAtByRule([])).size).toBe(0);
    // Disabling keeps the history, so the rule still says when it last fired.
    expect((await updateAlertRule(ruleId, { enabled: false }, 1)).lastFiredAt).toBe(at(2).toISOString());
  });

  it('keeps preserved subjects firing instead of resolving them', async () => {
    await addRule({ type: 'cert_expiring', params: '{"days":14}' });
    const h = harness();
    h.set({ status: 'ok', findings: [finding('managed_certificate:a.example.com'), finding('certificate:1')] });
    await h.run(at(0));
    h.set({ status: 'ok', findings: [], preservePrefixes: ['managed_certificate:'] });
    expect(await h.run(at(1))).toMatchObject({ resolved: 1 });
    const firing = await listFiringAlerts();
    expect(firing.map((alert) => alert.subjectKey)).toEqual(['managed_certificate:a.example.com']);
    expect(firing[0]).toMatchObject({ ruleName: 'Upstreams', severity: 'critical', title: 'managed_certificate:a.example.com is failing', firedAt: at(0).toISOString() });

    // The episode of the resolved subject has its end.
    const { events } = await listAlertEvents({ page: 1, perPage: 50 });
    const resolvedEpisode = events.find((event) => event.subjectKey === 'certificate:1' && event.status === 'firing')!;
    expect(resolvedEpisode.resolvedAt).toBe(at(1).toISOString());
    const stillFiring = events.find((event) => event.subjectKey === 'managed_certificate:a.example.com')!;
    expect(stillFiring.resolvedAt).toBeNull();
  });
});
