/**
 * Alert evaluation: firing/resolved transitions, cooldown, notification
 * routing, AI explanations that never hold up an alert.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

import * as schema from '../../src/lib/db/schema';
import { encryptSecret } from '../../src/lib/secret';
import { runAlertEvaluation, MAX_NEW_ALERTS_PER_RULE_RUN, type EngineDependencies } from '../../ee/alerting/engine';
import type { Evaluation, Finding } from '../../ee/alerting/evaluators';
import type { AlertNotification } from '../../ee/alerting/format';
import type { ResolvedChannel } from '../../ee/alerting/channels';

const T0 = new Date('2026-10-02T10:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

function finding(subjectKey: string, overrides: Partial<Finding> = {}): Finding {
  return {
    subjectKey,
    label: `Upstream ${subjectKey} failing`,
    title: `Upstream ${subjectKey} is failing`,
    message: `Caddy counted failures to ${subjectKey}.`,
    severity: 'critical',
    facts: { upstream: subjectKey, recentFailures: 3 },
    ...overrides,
  };
}

async function addChannel(type: 'email' | 'pagerduty', name: string, enabled = true): Promise<number> {
  const now = T0.toISOString();
  const [row] = await ctx.db
    .insert(schema.alertChannels)
    .values({
      name,
      type,
      enabled,
      config: JSON.stringify(type === 'email' ? { host: 'smtp.example.com', port: 587, secure: false, user: null, from: 'a@example.com', to: ['b@example.com'] } : { region: 'us' }),
      secrets: type === 'pagerduty' ? encryptSecret(JSON.stringify({ routingKey: 'routingkey000000' })) : null,
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
    .values({ name: 'Upstreams', type: 'upstream_down', params: '{"minFails":1}', channelIds: '[]', createdAt: now, updatedAt: now, ...values })
    .returning();
  return row.id;
}

/** Engine dependencies whose evaluation result the test sets per run. */
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
    deps,
    sent,
    set(evaluation: Evaluation) {
      current = evaluation;
    },
    async run(at: Date) {
      return runAlertEvaluation({ now: at, ...deps });
    },
  };
}

async function events() {
  return ctx.db.select().from(schema.alertEvents).orderBy(schema.alertEvents.id);
}

beforeEach(async () => {
  for (const table of [schema.alertEvents, schema.alertRuleStates, schema.alertRules, schema.alertChannels, schema.settings]) {
    await ctx.db.delete(table);
  }
});

describe('runAlertEvaluation', () => {
  it('notifies once when a subject starts firing and once when it resolves', async () => {
    const mail = await addChannel('email', 'Mail');
    const ruleId = await addRule({ channelIds: JSON.stringify([mail]) });
    const h = harness();

    h.set({ status: 'ok', findings: [finding('10.0.0.5:8080')] });
    expect(await h.run(T0)).toMatchObject({ rules: 1, fired: 1, resolved: 0, notifications: 1 });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].notification).toMatchObject({ kind: 'firing', ruleId, subjectKey: '10.0.0.5:8080', title: 'Upstream 10.0.0.5:8080 is failing', explanation: null });

    // Still firing: nothing new.
    expect(await h.run(minutes(1))).toMatchObject({ fired: 0, resolved: 0, notifications: 0 });
    expect(h.sent).toHaveLength(1);

    h.set({ status: 'ok', findings: [] });
    expect(await h.run(minutes(2))).toMatchObject({ fired: 0, resolved: 1, notifications: 1 });
    expect(h.sent[1].notification).toMatchObject({ kind: 'resolved', title: 'Resolved: Upstream 10.0.0.5:8080 failing', severity: 'info' });

    const history = await events();
    expect(history.map((event) => [event.status, event.notified])).toEqual([['firing', true], ['resolved', true]]);
    expect(JSON.parse(history[0].deliveries!)).toEqual([{ channelId: mail, channelName: 'Mail', ok: true, error: null }]);
    const [channel] = await ctx.db.select().from(schema.alertChannels);
    expect(channel.lastDeliveryAt).toBe(minutes(2).toISOString());
    expect(channel.lastDeliveryError).toBeNull();
  });

  it('suppresses a new firing notification inside the cooldown and records it', async () => {
    const mail = await addChannel('email', 'Mail');
    await addRule({ channelIds: JSON.stringify([mail]), cooldownMinutes: 30, notifyOnResolve: false });
    const h = harness();

    h.set({ status: 'ok', findings: [finding('a')] });
    await h.run(T0);
    h.set({ status: 'ok', findings: [] });
    await h.run(minutes(5));
    h.set({ status: 'ok', findings: [finding('a')] });
    await h.run(minutes(10));
    expect(h.sent.map((item) => item.notification.kind)).toEqual(['firing']);

    // The flap inside the cooldown resolves without a notice (its firing was not sent).
    h.set({ status: 'ok', findings: [] });
    await h.run(minutes(12));
    h.set({ status: 'ok', findings: [finding('a')] });
    await h.run(minutes(31));
    expect(h.sent.map((item) => item.notification.kind)).toEqual(['firing', 'firing']);

    const history = await events();
    expect(history.map((event) => [event.status, event.notified])).toEqual([
      ['firing', true],
      ['resolved', false],
      ['firing', false],
      ['resolved', false],
      ['firing', true],
    ]);
  });

  it('sends resolve notices only to PagerDuty when the rule does not ask for them', async () => {
    const mail = await addChannel('email', 'Mail');
    const pd = await addChannel('pagerduty', 'On call');
    await addRule({ channelIds: JSON.stringify([mail, pd]), notifyOnResolve: false });
    const h = harness();
    h.set({ status: 'ok', findings: [finding('a')] });
    await h.run(T0);
    expect(h.sent.map((item) => item.channel.type).sort()).toEqual(['email', 'pagerduty']);
    h.set({ status: 'ok', findings: [] });
    await h.run(minutes(1));
    expect(h.sent.slice(2).map((item) => [item.channel.type, item.notification.kind])).toEqual([['pagerduty', 'resolved']]);
    expect(h.sent[2].channel).toMatchObject({ type: 'pagerduty', secrets: { routingKey: 'routingkey000000' } });
  });

  it('changes nothing when the evaluator cannot tell', async () => {
    const mail = await addChannel('email', 'Mail');
    await addRule({ channelIds: JSON.stringify([mail]) });
    const h = harness();
    h.set({ status: 'ok', findings: [finding('a')] });
    await h.run(T0);
    h.set({ status: 'skipped', reason: 'The Caddy admin API could not be reached' });
    expect(await h.run(minutes(1))).toMatchObject({ skipped: 1, resolved: 0 });
    const [state] = await ctx.db.select().from(schema.alertRuleStates);
    expect(state.status).toBe('firing');
    expect(h.sent).toHaveLength(1);
  });

  it('records alerts without channels and skips disabled channels', async () => {
    const disabled = await addChannel('email', 'Off', false);
    await addRule({ channelIds: JSON.stringify([disabled]) });
    const h = harness();
    h.set({ status: 'ok', findings: [finding('a')] });
    await h.run(T0);
    expect(h.sent).toHaveLength(0);
    expect((await events()).map((event) => event.notified)).toEqual([false]);
  });

  it('appends the AI explanation when the rule asks for it', async () => {
    const mail = await addChannel('email', 'Mail');
    await addRule({ channelIds: JSON.stringify([mail]), explain: true });
    const h = harness();
    vi.mocked(h.deps.explain).mockResolvedValueOnce('The upstream stopped answering. Check the service.');
    h.set({ status: 'ok', findings: [finding('a')] });
    await h.run(T0);
    expect(h.deps.explain).toHaveBeenCalledWith({ ruleType: 'upstream_down', status: 'firing', severity: 'critical', facts: { upstream: 'a', recentFailures: 3 } });
    expect(h.sent[0].notification.explanation).toBe('The upstream stopped answering. Check the service.');
    expect((await events())[0].explanation).toBe('The upstream stopped answering. Check the service.');
  });

  it('still sends the alert when the explanation fails', async () => {
    const mail = await addChannel('email', 'Mail');
    await addRule({ channelIds: JSON.stringify([mail]), explain: true });
    const h = harness();
    vi.mocked(h.deps.explain).mockRejectedValueOnce(new Error('model down'));
    h.set({ status: 'ok', findings: [finding('a')] });
    await h.run(T0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].notification.explanation).toBeNull();
  });

  it('does not ask the model when explain is off', async () => {
    const mail = await addChannel('email', 'Mail');
    await addRule({ channelIds: JSON.stringify([mail]) });
    const h = harness();
    h.set({ status: 'ok', findings: [finding('a')] });
    await h.run(T0);
    expect(h.deps.explain).not.toHaveBeenCalled();
  });

  it('records delivery failures on the event and the channel', async () => {
    const mail = await addChannel('email', 'Mail');
    await addRule({ channelIds: JSON.stringify([mail]) });
    const h = harness();
    vi.mocked(h.deps.deliver).mockResolvedValueOnce({ ok: false, error: 'The SMTP server rejected the user name or password' });
    h.set({ status: 'ok', findings: [finding('a')] });
    expect(await h.run(T0)).toMatchObject({ fired: 1, notifications: 0 });
    expect(JSON.parse((await events())[0].deliveries!)).toEqual([
      { channelId: mail, channelName: 'Mail', ok: false, error: 'The SMTP server rejected the user name or password' },
    ]);
    const [channel] = await ctx.db.select().from(schema.alertChannels);
    expect(channel.lastDeliveryError).toBe('The SMTP server rejected the user name or password');
  });

  it('reports channels whose credentials no longer decrypt', async () => {
    const pd = await addChannel('pagerduty', 'On call');
    await ctx.db.update(schema.alertChannels).set({ secrets: 'enc:v1:AAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA' });
    await addRule({ channelIds: JSON.stringify([pd]) });
    const h = harness();
    h.set({ status: 'ok', findings: [finding('a')] });
    await h.run(T0);
    expect(h.deps.deliver).not.toHaveBeenCalled();
    expect(JSON.parse((await events())[0].deliveries!)[0].error).toMatch(/cannot be decrypted/);
  });

  it(`handles at most ${MAX_NEW_ALERTS_PER_RULE_RUN} new subjects per rule and run, the rest on the next run`, async () => {
    const mail = await addChannel('email', 'Mail');
    await addRule({ channelIds: JSON.stringify([mail]) });
    const h = harness();
    h.set({ status: 'ok', findings: Array.from({ length: MAX_NEW_ALERTS_PER_RULE_RUN + 5 }, (_, i) => finding(`s${i}`)) });
    expect((await h.run(T0)).fired).toBe(MAX_NEW_ALERTS_PER_RULE_RUN);
    expect((await h.run(minutes(1))).fired).toBe(5);
    expect(h.sent).toHaveLength(MAX_NEW_ALERTS_PER_RULE_RUN + 5);
  });

  it('ignores disabled rules and stored rules of a type that no longer exists', async () => {
    const mail = await addChannel('email', 'Mail');
    await addRule({ type: 'waf_spike', params: '{"threshold":1,"windowMinutes":5}', channelIds: JSON.stringify([mail]) });
    await addRule({ name: 'Off', enabled: false, channelIds: JSON.stringify([mail]) });
    await addRule({ name: 'Old', type: 'license_expiring', params: '{"days":30}', channelIds: JSON.stringify([mail]) });
    const h = harness();
    h.set({ status: 'ok', findings: [finding('waf')] });
    expect(await h.run(T0)).toMatchObject({ rules: 1, fired: 1, notifications: 1 });
  });

  it('keeps evaluating other rules when one throws', async () => {
    const mail = await addChannel('email', 'Mail');
    await addRule({ name: 'Broken', channelIds: JSON.stringify([mail]) });
    await addRule({ name: 'Fine', channelIds: JSON.stringify([mail]) });
    const h = harness();
    vi.mocked(h.deps.evaluate)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'ok', findings: [finding('a')] });
    expect(await h.run(T0)).toMatchObject({ rules: 2, skipped: 1, fired: 1 });
  });

  it('prunes history older than 90 days', async () => {
    await ctx.db.insert(schema.alertEvents).values({
      ruleId: 1, ruleName: 'old', ruleType: 'upstream_down', subjectKey: 'a', status: 'firing', severity: 'warning',
      title: 'old', message: 'old', createdAt: new Date(T0.getTime() - 91 * 86400_000).toISOString(),
    });
    await harness().run(T0);
    expect(await events()).toHaveLength(0);
  });
});
