/**
 * Saved analytics questions in compliance report schedules (ee/compliance,
 * ee/ai/questions): a schedule copies the saved questions its editor can
 * see, and each run adds a "Traffic questions" report that re-runs them for
 * the period over every host, with bound parameters and without asking an AI
 * model. The copies outlive the saved question and its owner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  seen: [] as string[],
  calls: [] as { query: string; query_params: Record<string, unknown> }[],
  modelCalls: 0,
}));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/clickhouse/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/clickhouse/client')>();
  return {
    ...actual,
    isAnalyticsEnabled: () => true,
    getRetentionDays: () => 90,
    queryDistinctHostsAll: async () => ctx.seen,
    getClient: () => ({
      query: async (args: { query: string; query_params: Record<string, unknown> }) => {
        ctx.calls.push(args);
        const rows = args.query.includes('count() AS total')
          ? [{ total: 1000, d0: 3 }]
          : args.query.includes(' AS value')
            ? [{ value: 'DE', c: 600, m: 600 }, { value: 'US', c: 300, m: 300 }, { value: 'CN', c: 100, m: 100 }]
            : [];
        return { json: async () => rows };
      },
    }),
  };
});

// A report never asks the model.
vi.mock('../../ee/ai/explain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ee/ai/explain')>();
  return {
    ...actual,
    requestModelText: async () => {
      ctx.modelCalls += 1;
      return { ok: false, error: 'not expected' };
    },
  };
});

import { logAuditEvent } from '../../src/lib/audit';
import { deleteUser } from '../../src/lib/models/user';
import { createReportSchedule, getReportSchedule, runReportScheduleNow, updateReportSchedule } from '../../ee/compliance/schedules';
import { generateReport, getReport } from '../../ee/compliance/reports';
import type { AnalyticsDependencies } from '../../ee/compliance/reports/shared';
import { first } from '@/src/lib/db/ops';

const NOW = new Date('2026-10-03T11:36:00.000Z');
const withAnalytics: AnalyticsDependencies = { analyticsEnabled: () => true, query: async () => [] };
const noAnalytics: AnalyticsDependencies = { analyticsEnabled: () => false, query: async () => [] };
const ADMIN = 1;
const OTHER = 2;
let ids: { mine: number; othersPrivate: number; othersShared: number };

const COUNTRY_QUERY = {
  metric: 'mitigated',
  breakdown: 'country',
  filters: [],
  hostTags: ['shop'],
  range: { preset: '7d' },
  comparison: 'previous_period',
  limit: 5,
};

async function saveQuestion(userId: number, question: string, shared: boolean, query: Record<string, unknown> = COUNTRY_QUERY): Promise<number> {
  const t = NOW.toISOString();
  return (await first(ctx.db.insert(schema.analyticsQuestions).values({ userId, question, query: JSON.stringify(query), shared, createdAt: t, updatedAt: t }).returning()))!.id;
}

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.calls = [];
  ctx.modelCalls = 0;
  ctx.seen = ['shop.example.com', 'shop.example.com:443', 'admin.example.org'];
  vi.mocked(logAuditEvent).mockClear();
  const t = NOW.toISOString();
  for (const [id, role] of [[ADMIN, 'admin'], [OTHER, 'admin']] as const) {
    await ctx.db.insert(schema.users).values({
      id, email: `user${id}@example.com`, name: `User ${id}`, role, provider: 'credentials', subject: `user${id}`, status: 'active', createdAt: t, updatedAt: t,
    });
  }
  await ctx.db.insert(schema.proxyHosts).values({
    id: 1, name: 'Shop', domains: '["shop.example.com"]', upstreams: '["shop:8080"]', tags: '["shop"]', createdAt: t, updatedAt: t,
  });
  await ctx.db.insert(schema.proxyHosts).values({
    id: 2, name: 'Admin', domains: '["admin.example.org"]', upstreams: '["admin:8080"]', tags: '["internal"]', createdAt: t, updatedAt: t,
  });
  ids = {
    mine: await saveQuestion(ADMIN, 'Which countries were blocked most on the shop hosts?', false),
    othersPrivate: await saveQuestion(OTHER, 'A private question of someone else', false),
    othersShared: await saveQuestion(OTHER, 'How many requests over time?', true, { metric: 'requests', breakdown: 'time', range: { preset: '24h' } }),
  };
});

describe('questions in a report schedule', () => {
  it('copies the saved questions its editor can see', async () => {
    const schedule = await createReportSchedule({ name: 'Traffic evidence', reportTypes: [], questionIds: [ids.mine, ids.othersShared] }, ADMIN, NOW);
    expect(schedule.reportTypes).toEqual([]);
    expect(schedule.questions).toEqual([
      { savedQuestionId: ids.mine, question: 'Which countries were blocked most on the shop hosts?', interpretation: 'Mitigated requests by country (top 5), the last 7 days, hosts tagged shop, compared with the period before' },
      { savedQuestionId: ids.othersShared, question: 'How many requests over time?', interpretation: 'Requests over time, the last 24 hours' },
    ]);
    const [created] = vi.mocked(logAuditEvent).mock.calls.map(([event]) => event).filter((event) => event.action === 'compliance_schedule_created');
    expect((created.data as { questions: unknown[] }).questions).toHaveLength(2);

    await expect(createReportSchedule({ name: 'x', questionIds: [ids.othersPrivate] }, ADMIN, NOW)).rejects.toThrow(/does not exist or is not visible to you/);
    await expect(createReportSchedule({ name: 'x', questionIds: [999] }, ADMIN, NOW)).rejects.toThrow(/does not exist or is not visible to you/);
    await expect(createReportSchedule({ name: 'x', reportTypes: ['traffic_questions'] }, ADMIN, NOW)).rejects.toThrow(/questionIds/);
    await expect(createReportSchedule({ name: 'x', reportTypes: [], questionIds: [] }, ADMIN, NOW)).rejects.toThrow(/reportTypes must list at least one report type, or questionIds at least one saved question/);
    await expect(createReportSchedule({ name: 'x', questionIds: Array.from({ length: 11 }, (_, i) => i + 1) }, ADMIN, NOW)).rejects.toThrow(/at most 10 questions/);
    await expect(createReportSchedule({ name: 'x', questionIds: ['1'] }, ADMIN, NOW)).rejects.toThrow(/questionIds must be/);

    expect(await updateReportSchedule(schedule.id, { enabled: false }, ADMIN, NOW)).toMatchObject({ enabled: false, questions: schedule.questions });
  });

  it('adds a Traffic questions report to each run, re-run for the period over every host without a model', async () => {
    const schedule = await createReportSchedule({ name: 'Monthly traffic', frequency: 'monthly', reportTypes: [], questionIds: [ids.mine] }, ADMIN, NOW);
    const run = await runReportScheduleNow(schedule.id, ADMIN, { now: () => NOW, analytics: withAnalytics });
    expect(run.status).toBe('success');
    expect(run.reports.map((report) => report.type)).toEqual(['traffic_questions']);
    expect(ctx.modelCalls).toBe(0);

    const report = await getReport(run.reports[0].id);
    expect(report.title).toBe('Traffic questions');
    expect(report.integrity.contentMatches).toBe(true);
    const document = report.document;
    expect(document.period).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' });
    expect(document.summary).toEqual([
      { key: 'questions', label: 'Questions', value: 1 },
      { key: 'answered', label: 'Answered', value: 1 },
      { key: 'notAnswered', label: 'Not answered', value: 0 },
    ]);
    expect(document.findings).toEqual([]);
    expect(document.controls.map((control) => control.ref)).toEqual(['Art. 21(2)(f)', 'Art. 21(2)(b)', 'A.8.16', 'A.5.28']);
    expect(document.notes.join(' ')).toMatch(/no AI model is asked/);
    const [section] = document.sections;
    expect(section.title).toBe('Which countries were blocked most on the shop hosts?');
    expect(section.description).toMatch(/^Mitigated requests by country \(top 5\), 1 Sep–30 Sep 2026, hosts tagged shop, compared with the 30 days before\. DE had the most mitigated requests/);
    expect(section.columns.map((column) => column.label)).toEqual(['#', 'Country', 'Name', 'Mitigated requests', 'Share (%)', 'Previous period', 'Change (%)']);
    expect(section.rows[0]).toEqual({ rank: 1, value: 'DE', name: null, count: 600, share: 60, previous: 600, change: 0 });

    // The report's exact period, the tagged host's names and constant SQL.
    const traffic = ctx.calls.filter((call) => call.query.includes('traffic_events'));
    expect(traffic.length).toBeGreaterThan(0);
    const current = traffic[0];
    expect(current.query_params).toMatchObject({
      p_from: Date.parse('2026-09-01T00:00:00Z') / 1000,
      p_to: Date.parse('2026-10-01T00:00:00Z') / 1000,
      p_scope: ['shop.example.com', 'shop.example.com:443'],
    });
    for (const call of traffic) expect(call.query).not.toMatch(/shop\.example|admin\.example/);
  });

  it('keeps its copy when the saved question or its owner is deleted', async () => {
    const schedule = await createReportSchedule({ name: 'Shared', reportTypes: ['change_log'], questionIds: [ids.othersShared] }, ADMIN, NOW);
    await deleteUser(OTHER);
    expect(await first(ctx.db.select().from(schema.analyticsQuestions).where(eq(schema.analyticsQuestions.id, ids.othersShared)).limit(1))).toBeUndefined();
    expect((await getReportSchedule(schedule.id)).questions.map((q) => q.question)).toEqual(['How many requests over time?']);
    // Saving the schedule again with the same id keeps the copy.
    expect((await updateReportSchedule(schedule.id, { questionIds: [ids.othersShared, ids.mine] }, ADMIN, NOW)).questions.map((q) => q.savedQuestionId)).toEqual([
      ids.othersShared,
      ids.mine,
    ]);
    const run = await runReportScheduleNow(schedule.id, ADMIN, { now: () => NOW, analytics: withAnalytics });
    expect(run.reports.map((report) => report.type)).toEqual(['change_log', 'traffic_questions']);
    const document = (await getReport(run.reports[1].id)).document;
    expect(document.sections.map((section) => section.title)).toEqual(['How many requests over time?', 'Which countries were blocked most on the shop hosts?']);
    expect(document.sections[0].columns.map((column) => column.key)).toEqual(['from', 'value']);

    expect((await updateReportSchedule(schedule.id, { questionIds: [] }, ADMIN, NOW)).questions).toEqual([]);
  });

  it('records questions it could not answer as findings', async () => {
    const schedule = await createReportSchedule({ name: 'No analytics', reportTypes: [], questionIds: [ids.mine] }, ADMIN, NOW);
    const run = await runReportScheduleNow(schedule.id, ADMIN, { now: () => NOW, analytics: noAnalytics });
    const document = (await getReport(run.reports[0].id)).document;
    expect(document.sections[0].rows).toEqual([{ status: 'Not answered' }]);
    expect(document.findings).toEqual([
      expect.objectContaining({ severity: 'info', code: 'question_not_answered', subject: 'question:1' }),
    ]);
    expect(ctx.calls).toHaveLength(0);

    // A tag no proxy host carries any more.
    await ctx.db.update(schema.proxyHosts).set({ tags: '[]' }).where(eq(schema.proxyHosts.id, 1));
    const again = await runReportScheduleNow(schedule.id, ADMIN, { now: () => NOW, analytics: withAnalytics });
    const tagless = (await getReport(again.reports[0].id)).document;
    expect(tagless.sections[0].description).toBe('No proxy host is tagged "shop". Tags you can use: internal.');
  });

  it('is never generated by hand', async () => {
    await expect(generateReport({ type: 'traffic_questions' }, ADMIN, { now: () => NOW, analytics: withAnalytics })).rejects.toThrow(
      /Traffic questions reports are generated by report schedules/
    );
  });
});
