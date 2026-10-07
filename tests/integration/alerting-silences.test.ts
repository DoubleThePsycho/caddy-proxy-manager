/**
 * Dismissing alerts and muting rules (ee/alerting/silences.ts): what the
 * engine notifies and records while a rule is muted or an alert dismissed,
 * when mutes and dismissals end, Needs attention and the sidebar badge, and
 * the REST API (validation, the audit log).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return {
    ...actual,
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  };
});

import { eq } from 'drizzle-orm';
import * as schema from '../../src/lib/db/schema';
import { runAlertEvaluation, type EngineDependencies } from '../../ee/alerting/engine';
import type { Evaluation, Finding } from '../../ee/alerting/evaluators';
import type { AlertNotification } from '../../ee/alerting/format';
import type { ResolvedChannel } from '../../ee/alerting/channels';
import { listFiringAlerts } from '../../ee/alerting/events';
import { alertsAttentionProvider } from '../../ee/alerting/attention';
import { updateAlertRule } from '../../ee/alerting/rules';
import { GET as listSilences, POST as createSilence } from '../../app/api/v1/alert-silences/route';
import { DELETE as deleteSilence } from '../../app/api/v1/alert-silences/[id]/route';
import { GET as listFiring } from '../../app/api/v1/alert-events/firing/route';
import { GET as listRules } from '../../app/api/v1/alert-rules/route';
import { DELETE as deleteRule } from '../../app/api/v1/alert-rules/[id]/route';
import { logAuditEvent } from '../../src/lib/audit';
import { adminAccess } from '../../src/lib/permissions';
import { getNavSummary } from '../../src/lib/nav-summary';
import { encryptSecret } from '../../src/lib/secret';

const T0 = new Date('2026-10-02T10:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const HOUR = 60;

function finding(subjectKey: string): Finding {
  return {
    subjectKey,
    label: `Upstream ${subjectKey} failing`,
    title: `Upstream ${subjectKey} is failing`,
    message: `Caddy counted failures to ${subjectKey}.`,
    severity: 'critical',
    facts: { upstream: subjectKey },
  };
}

async function addChannel(type: 'email' | 'slack' = 'email'): Promise<number> {
  const now = T0.toISOString();
  const [row] = await ctx.db
    .insert(schema.alertChannels)
    .values({
      name: type === 'email' ? 'Mail' : 'Slack',
      type,
      config: JSON.stringify(type === 'email' ? { host: 'smtp.example.com', port: 587, secure: false, user: null, from: 'a@example.com', to: ['b@example.com'] } : {}),
      secrets: type === 'slack' ? encryptSecret(JSON.stringify({ webhookUrl: 'https://hooks.example.com/services/x' })) : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row.id;
}

async function addRule(values: Partial<typeof schema.alertRules.$inferInsert> = {}): Promise<number> {
  const now = T0.toISOString();
  const [row] = await ctx.db
    .insert(schema.alertRules)
    .values({ name: 'Upstreams', type: 'upstream_down', params: '{"minFails":1}', channelIds: '[]', cooldownMinutes: 0, createdAt: now, updatedAt: now, ...values })
    .returning();
  return row.id;
}

async function addSilence(values: { ruleId: number; subjectKey?: string | null; until?: string | null; note?: string | null; createdBy?: number | null }) {
  const [row] = await ctx.db
    .insert(schema.alertSilences)
    .values({ subjectKey: null, until: null, note: null, createdBy: 1, createdAt: T0.toISOString(), ...values })
    .returning();
  return row.id;
}

async function addFiring(ruleId: number, subjectKey: string, at = T0.toISOString()) {
  await ctx.db.insert(schema.alertRuleStates).values({ ruleId, subjectKey, status: 'firing', title: `${subjectKey} failing`, firedAt: at, lastEvaluatedAt: at });
  await ctx.db.insert(schema.alertEvents).values({
    ruleId, ruleName: 'Rule', ruleType: 'upstream_down', subjectKey, status: 'firing', severity: 'critical',
    title: `${subjectKey} is failing`, message: 'Check it.', notified: true, createdAt: at,
  });
}

function harness() {
  let current: Evaluation = { status: 'ok', findings: [] };
  const sent: { channel: ResolvedChannel; notification: AlertNotification }[] = [];
  const deps: EngineDependencies = {
    evaluate: vi.fn(async () => current),
    deliver: vi.fn(async (channel: ResolvedChannel, notification: AlertNotification) => {
      sent.push({ channel, notification });
      return { ok: true as const, error: null };
    }),
    explain: vi.fn(async () => null),
  };
  return {
    sent,
    firing(...keys: string[]) {
      current = { status: 'ok', findings: keys.map(finding) };
    },
    async run(at: Date) {
      return runAlertEvaluation({ now: at, ...deps });
    },
  };
}

async function events() {
  return (await ctx.db.select().from(schema.alertEvents).orderBy(schema.alertEvents.id)).map((event) => [event.subjectKey, event.status, event.notified, event.silenced]);
}

async function silences() {
  return ctx.db.select().from(schema.alertSilences).orderBy(schema.alertSilences.id);
}

function request(method: string, body?: unknown): any {
  return {
    method,
    headers: { get: () => null },
    nextUrl: { pathname: '/api/v1/test', searchParams: new URLSearchParams() },
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  };
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

async function post(body: unknown): Promise<{ status: number; data: any }> {
  const response = await createSilence(request('POST', body));
  return { status: response.status, data: await response.json() };
}

beforeEach(async () => {
  for (const table of [schema.alertSilences, schema.alertEvents, schema.alertRuleStates, schema.alertRules, schema.alertChannels, schema.settings, schema.users]) {
    await ctx.db.delete(table);
  }
  const now = new Date().toISOString();
  await ctx.db.insert(schema.users).values({ id: 1, email: 'alex@example.com', name: 'Alex Morgan', role: 'admin', status: 'active', createdAt: now, updatedAt: now });
  vi.mocked(logAuditEvent).mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('the engine with mutes and dismissals', () => {
  it('records what fires while the rule is muted without notifying, and sends no resolve notice for it', async () => {
    const ruleId = await addRule({ channelIds: JSON.stringify([await addChannel()]) });
    await addSilence({ ruleId, until: minutes(HOUR).toISOString() });
    const h = harness();

    h.firing('a');
    expect(await h.run(T0)).toMatchObject({ fired: 1, notifications: 0 });
    // The mute ends while it still fires: nothing is sent late.
    await h.run(minutes(HOUR + 10));
    expect(await silences()).toEqual([]);
    h.firing();
    expect(await h.run(minutes(HOUR + 20))).toMatchObject({ resolved: 1, notifications: 0 });
    expect(h.sent).toEqual([]);

    // Once the mute is over, a new alert notifies again.
    h.firing('b');
    await h.run(minutes(HOUR + 30));
    expect(h.sent.map((item) => [item.notification.kind, item.notification.subjectKey])).toEqual([['firing', 'b']]);
    expect(await events()).toEqual([
      ['a', 'firing', false, 'muted'],
      ['a', 'resolved', false, 'muted'],
      ['b', 'firing', true, null],
    ]);
  });

  it('covers a subject dismissed for a period when it resolves and fires again within it', async () => {
    const ruleId = await addRule({ channelIds: JSON.stringify([await addChannel()]) });
    const h = harness();
    h.firing('a');
    await h.run(T0);
    await addSilence({ ruleId, subjectKey: 'a', until: minutes(8 * HOUR).toISOString() });

    // Its firing notification went out, so the resolve notice does too.
    h.firing();
    await h.run(minutes(10));
    h.firing('a');
    expect(await h.run(minutes(20))).toMatchObject({ fired: 1, notifications: 0 });
    h.firing();
    expect(await h.run(minutes(30))).toMatchObject({ resolved: 1, notifications: 0 });
    // Another subject of the same rule is not covered.
    h.firing('b');
    await h.run(minutes(40));
    // After the period, the subject notifies again (and the dismissal is gone).
    h.firing('a', 'b');
    await h.run(minutes(9 * HOUR));
    expect(await silences()).toEqual([]);
    expect(h.sent.map((item) => [item.notification.kind, item.notification.subjectKey])).toEqual([
      ['firing', 'a'],
      ['resolved', 'a'],
      ['firing', 'b'],
      ['firing', 'a'],
    ]);
    expect(await events()).toEqual([
      ['a', 'firing', true, null],
      ['a', 'resolved', true, null],
      ['a', 'firing', false, 'dismissed'],
      ['a', 'resolved', false, 'dismissed'],
      ['b', 'firing', true, null],
      ['a', 'firing', true, null],
    ]);
  });

  it('ends a dismissal until it resolves when the subject resolves', async () => {
    const ruleId = await addRule({ channelIds: JSON.stringify([await addChannel()]) });
    const h = harness();
    h.firing('a', 'b');
    await h.run(T0);
    await addSilence({ ruleId, subjectKey: 'a' });

    await h.run(minutes(1));
    expect((await silences()).map((row) => row.subjectKey)).toEqual(['a']);
    h.firing('b');
    await h.run(minutes(2));
    expect(await silences()).toEqual([]);
    // Fires again later: a new alert, notified as usual.
    h.firing('a', 'b');
    await h.run(minutes(3));
    expect(h.sent.map((item) => [item.notification.kind, item.notification.subjectKey])).toEqual([
      ['firing', 'a'],
      ['firing', 'b'],
      ['resolved', 'a'],
      ['firing', 'a'],
    ]);
  });

  it('prunes expired mutes and dismissals, and dismissals of alerts no longer firing', async () => {
    const ruleId = await addRule();
    const h = harness();
    h.firing('a');
    await h.run(T0);
    const keep = [
      await addSilence({ ruleId, until: minutes(HOUR).toISOString() }),
      await addSilence({ ruleId, subjectKey: 'a' }),
      await addSilence({ ruleId, subjectKey: 'c', until: minutes(HOUR).toISOString() }),
    ];
    await addSilence({ ruleId, until: minutes(1).toISOString() });
    await addSilence({ ruleId, subjectKey: 'a', until: minutes(2).toISOString() });
    await addSilence({ ruleId, subjectKey: 'gone' });

    await h.run(minutes(5));
    expect((await silences()).map((row) => row.id)).toEqual(keep);
  });

  it('forgets the mutes and dismissals of a deleted rule, and the dismissals until resolved of a disabled one', async () => {
    const first = await addRule({ name: 'First' });
    const second = await addRule({ name: 'Second' });
    await addFiring(first, 'a');
    await addFiring(second, 'b');
    await addSilence({ ruleId: first, subjectKey: 'a' });
    await addSilence({ ruleId: first, until: minutes(HOUR).toISOString() });
    const timed = await addSilence({ ruleId: second, subjectKey: 'b', until: '2099-01-01T00:00:00.000Z' });
    await addSilence({ ruleId: second, subjectKey: 'b2' });

    expect((await deleteRule(request('DELETE'), params(first))).status).toBe(204);
    expect((await silences()).map((row) => row.ruleId)).toEqual([second, second]);
    await updateAlertRule(second, { enabled: false }, 1);
    expect((await silences()).map((row) => row.id)).toEqual([timed]);
  });
});

describe('Needs attention and the sidebar badge', () => {
  it('leave dismissed alerts and alerts of muted rules out, which stay listed as firing, marked', async () => {
    const first = await addRule({ name: 'First' });
    const second = await addRule({ name: 'Second' });
    await addFiring(first, 'a1');
    await addFiring(first, 'a2', minutes(-10).toISOString());
    await addFiring(second, 'b1', minutes(-5).toISOString());
    const now = new Date();
    await addSilence({ ruleId: first, subjectKey: 'a1', note: 'On it' });
    await addSilence({ ruleId: second, until: new Date(now.getTime() + 3_600_000).toISOString() });
    // Ended but not pruned yet: no longer covers anything.
    await addSilence({ ruleId: first, subjectKey: 'a2', until: new Date(now.getTime() - 60_000).toISOString() });

    const alerts = await listFiringAlerts();
    expect(alerts.map((alert) => [alert.subjectKey, alert.dismissal?.kind ?? null, alert.mute?.kind ?? null])).toEqual([
      ['a2', null, null],
      ['a1', 'dismissal', null],
      ['b1', null, 'mute'],
    ]);
    expect(alerts[1].dismissal).toMatchObject({ ruleName: 'First', subjectKey: 'a1', subjectTitle: 'a1 failing', until: null, note: 'On it', createdBy: 1, createdByName: 'Alex Morgan' });

    const items = await alertsAttentionProvider.collect({ access: adminAccess(1), now });
    expect(items.map((item) => item.id)).toEqual([`${first}:a2`]);
    const { badges } = await getNavSummary(adminAccess(1), { pending: 0, dueAt: null, overdue: false });
    expect(badges.alertsFiring).toMatchObject({ text: '1', label: '1 alert firing' });

    await ctx.db.delete(schema.alertSilences);
    expect((await getNavSummary(adminAccess(1), { pending: 0, dueAt: null, overdue: false })).badges.alertsFiring).toMatchObject({ text: '3' });
  });
});

describe('REST API', () => {
  async function certificateRule(): Promise<number> {
    return addRule({ name: 'Certificates', type: 'cert_expiring', params: '{"days":14}', channelIds: JSON.stringify([await addChannel('email')]) });
  }

  it('dismisses a firing alert until it resolves, lists it and undoes it', async () => {
    const ruleId = await certificateRule();
    await addFiring(ruleId, 'certificate:1');

    const { status, data } = await post({ ruleId, subjectKey: 'certificate:1', note: '  Renewal ordered  ' });
    expect(status).toBe(201);
    expect(data).toMatchObject({
      kind: 'dismissal', ruleId, ruleName: 'Certificates', subjectKey: 'certificate:1', subjectTitle: 'certificate:1 failing',
      until: null, note: 'Renewal ordered', createdBy: 1, createdByName: 'Alex Morgan',
    });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 1, action: 'alert_silence_created', entityType: 'alert_silence', entityId: data.id,
      summary: 'Dismissed alert "certificate:1 failing" of rule "Certificates" until it resolves',
    }));

    const listed = await (await listSilences(request('GET'))).json();
    expect(listed).toEqual([data]);
    const firing = await (await listFiring(request('GET'))).json();
    expect(firing.alerts[0]).toMatchObject({ subjectKey: 'certificate:1', dismissal: { id: data.id }, mute: null });

    expect((await deleteSilence(request('DELETE'), params(data.id))).status).toBe(204);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'alert_silence_deleted', entityType: 'alert_silence', entityId: data.id,
      summary: 'Removed the dismissal of alert "certificate:1 failing" of rule "Certificates"',
    }));
    expect(await (await listSilences(request('GET'))).json()).toEqual([]);
    expect((await deleteSilence(request('DELETE'), params(data.id))).status).toBe(404);
  });

  it('mutes a rule for a duration, shows it on the rule and replaces an earlier mute', async () => {
    const ruleId = await certificateRule();
    const before = Date.now();
    const first = await post({ ruleId, durationMinutes: 60 });
    expect(first.status).toBe(201);
    expect(first.data).toMatchObject({ kind: 'mute', subjectKey: null, subjectTitle: null });
    const until = Date.parse(first.data.until);
    expect(until).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'alert_silence_created', summary: expect.stringMatching(/^Muted alert rule "Certificates" until /) }));

    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const second = await post({ ruleId, until: at, note: 'Maintenance' });
    expect(second.data).toMatchObject({ kind: 'mute', until: at, note: 'Maintenance' });
    expect((await silences()).map((row) => row.id)).toEqual([second.data.id]);
    const rules = await (await listRules(request('GET'))).json();
    expect(rules[0].mute).toMatchObject({ id: second.data.id, until: at });

    // A timed dismissal of an alert that is not firing is accepted (it covers it if it fires).
    const timed = await post({ ruleId, subjectKey: 'certificate:9', durationMinutes: 480 });
    expect(timed.status).toBe(201);
    expect(timed.data).toMatchObject({ kind: 'dismissal', subjectTitle: null });
  });

  it.each([
    ['an unknown rule', { ruleId: 999, durationMinutes: 60 }, 400],
    ['a ruleId that is not an id', { ruleId: '1', durationMinutes: 60 }, 400],
    ['a mute without a duration', { durationMinutes: undefined }, 400],
    ['a zero duration', { durationMinutes: 0 }, 400],
    ['a duration over 30 days', { durationMinutes: 30 * 24 * 60 + 1 }, 400],
    ['a fractional duration', { durationMinutes: 1.5 }, 400],
    ['until in the past', { until: '2020-01-01T00:00:00.000Z' }, 400],
    ['until more than 30 days ahead', { until: '2099-01-01T00:00:00.000Z' }, 400],
    ['until that is not a date', { until: 'tomorrow' }, 400],
    ['both until and durationMinutes', { until: new Date(Date.now() + 3_600_000).toISOString(), durationMinutes: 60 }, 400],
    ['a note over 500 characters', { durationMinutes: 60, note: 'x'.repeat(501) }, 400],
    ['a note with control characters', { durationMinutes: 60, note: 'a\u0007b' }, 400],
    ['an empty subjectKey', { subjectKey: '', durationMinutes: 60 }, 400],
    ['an unknown field', { durationMinutes: 60, kind: 'mute' }, 400],
    ['dismissing until it resolves an alert that is not firing', { subjectKey: 'certificate:2' }, 409],
  ])('refuses %s', async (_label, overrides, expected) => {
    const ruleId = await certificateRule();
    const body = { ruleId, ...overrides };
    expect((await post(body)).status).toBe(expected);
    expect(await silences()).toEqual([]);
  });

  it('refuses a body that is not JSON', async () => {
    expect((await createSilence(request('POST'))).status).toBe(400);
  });

  it('treats a stored rule of a type that no longer exists as missing', async () => {
    const ruleId = await addRule({ name: 'Old', type: 'license_expiring', params: '{"days":30}' });
    expect((await post({ ruleId, durationMinutes: 60 })).status).toBe(400);
    expect(await silences()).toEqual([]);
  });

  it('dismisses and mutes alerts of any rule, and undoes it', async () => {
    const upstreams = await addRule({ name: 'Upstreams' });
    await addFiring(upstreams, 'upstream:a');
    const slackCertificates = await addRule({ name: 'Slack certificates', type: 'cert_expiring', params: '{"days":14}', channelIds: JSON.stringify([await addChannel('slack')]) });
    const dismissed = await post({ ruleId: upstreams, subjectKey: 'upstream:a' });
    const muted = await post({ ruleId: slackCertificates, durationMinutes: 60 });
    expect([dismissed.status, muted.status]).toEqual([201, 201]);

    expect((await deleteSilence(request('DELETE'), params(dismissed.data.id))).status).toBe(204);
    expect((await deleteSilence(request('DELETE'), params(muted.data.id))).status).toBe(204);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'alert_silence_deleted', summary: 'Unmuted alert rule "Slack certificates"' }));
    expect(await silences()).toEqual([]);
  });

  it('keeps the dismissal of a deleted user, without a name', async () => {
    const ruleId = await certificateRule();
    await addFiring(ruleId, 'certificate:1');
    await post({ ruleId, subjectKey: 'certificate:1' });
    await ctx.db.delete(schema.users).where(eq(schema.users.id, 1));
    const [view] = await (await listSilences(request('GET'))).json();
    expect(view).toMatchObject({ createdBy: 1, createdByName: null });
  });
});
