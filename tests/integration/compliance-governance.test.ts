/**
 * Compliance additions (ee/compliance): report schedules and evidence packs,
 * recorded test restores, the live control status, and the incident register
 * (window, significance assessment, classification, cause, timeline), with
 * their validation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { seedCompliance, type Seed } from '../helpers/compliance';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return { ...actual, requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))), requireApiAdmin: vi.fn() };
});

import { requireApiAdmin } from '../../src/lib/api-auth';
import { logAuditEvent } from '../../src/lib/audit';
import {
  createReportSchedule,
  deleteReportSchedule,
  getReportSchedule,
  listEvidencePacks,
  nextScheduledRun,
  periodOfRun,
  runDueReportSchedules,
  runReportScheduleNow,
  updateReportSchedule,
} from '../../ee/compliance/schedules';
import { deleteRestoreTest, listRestoreTests, recordRestoreTest } from '../../ee/compliance/restore-tests';
import { getControlStatus } from '../../ee/compliance/control-status';
import { createIncident, getIncident, listIncidents, updateIncident } from '../../ee/compliance/incidents';
import { suggestedClassification, emptyAssessment } from '../../ee/compliance/incident-register';
import type { AnalyticsDependencies } from '../../ee/compliance/reports/shared';
import type { Notice } from '../../ee/alerting/notice';
import * as schedulesRoute from '../../app/api/v1/compliance/schedules/route';
import * as statusRoute from '../../app/api/v1/compliance/controls/status/route';
import * as restoreRoute from '../../app/api/v1/compliance/restore-tests/route';
import { first } from '@/src/lib/db/ops';

const NOW = new Date('2026-10-03T11:36:00.000Z');
const noAnalytics: AnalyticsDependencies = { analyticsEnabled: () => false, query: async () => [] };
let seed: Seed;

function req(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

async function addEmailChannel(): Promise<number> {
  return (await first(ctx.db.insert(schema.alertChannels).values({
    name: 'Ops mail', type: 'email',
    config: JSON.stringify({ host: 'smtp.example.com', port: 587, secure: false, user: null, from: 'alerts@example.com', to: ['ops@example.com'] }),
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  }).returning()))!.id;
}

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  seed = await seedCompliance(ctx.db, NOW);
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId: seed.adminId, role: 'admin', authMethod: 'bearer' });
});

describe('report schedules', () => {
  it('runs monthly for the previous calendar month and weekly for the seven days before', () => {
    const monthly = { frequency: 'monthly' as const, weekday: 'monday' as const, dayOfMonth: 1, time: '06:00', timeZone: 'UTC' };
    const next = nextScheduledRun(monthly, NOW);
    expect(next.toISOString()).toBe('2026-11-01T06:00:00.000Z');
    expect(periodOfRun(monthly, next)).toEqual({ from: new Date('2026-10-01T00:00:00.000Z'), to: new Date('2026-10-31T23:59:59.999Z') });

    const weekly = { frequency: 'weekly' as const, weekday: 'monday' as const, dayOfMonth: 1, time: '06:00', timeZone: 'Europe/Rome' };
    const run = nextScheduledRun(weekly, NOW);
    expect(run.toISOString()).toBe('2026-10-05T04:00:00.000Z');
    // Monday 5 Oct 06:00 in Rome covers Monday 28 Sep to Sunday 4 Oct, local time.
    expect(periodOfRun(weekly, run)).toEqual({ from: new Date('2026-09-27T22:00:00.000Z'), to: new Date('2026-10-04T21:59:59.999Z') });
  });

  it('sets one up, changes, disables and deletes it', async () => {
    const schedule = await createReportSchedule({ name: 'Monthly evidence' }, seed.adminId, NOW);
    expect(schedule).toMatchObject({
      enabled: true, frequency: 'monthly', dayOfMonth: 1, weekday: null, time: '06:00', timeZone: 'UTC',
      reportTypes: ['access_review', 'change_log', 'certificate_inventory', 'protection_coverage'],
      nextRunAt: '2026-11-01T06:00:00.000Z',
      nextPeriod: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' },
      lastReports: [],
    });
    expect(await updateReportSchedule(schedule.id, { name: 'Renamed' }, seed.adminId)).toMatchObject({ name: 'Renamed' });
    expect(await updateReportSchedule(schedule.id, { enabled: false }, seed.adminId)).toMatchObject({ enabled: false, nextRunAt: null });
    await deleteReportSchedule(schedule.id, seed.adminId);
    await expect(getReportSchedule(schedule.id)).rejects.toThrow('Report schedule not found');
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'compliance_schedule_deleted', entityId: schedule.id }));
  });

  it.each([
    [{ name: '' }, /name is required/],
    [{ name: 'x', frequency: 'daily' }, /frequency must be weekly or monthly/],
    [{ name: 'x', frequency: 'weekly', weekday: 'funday' }, /weekday must be one of/],
    [{ name: 'x', dayOfMonth: 31 }, /dayOfMonth must be a whole number from 1 to 28/],
    [{ name: 'x', time: '25:00' }, /time must be a time of day/],
    [{ name: 'x', timeZone: 'Mars/Base' }, /timeZone must be an IANA time zone/],
    [{ name: 'x', reportTypes: [] }, /reportTypes must list at least one/],
    [{ name: 'x', reportTypes: ['secrets'] }, /reportTypes must contain/],
    [{ name: 'x', channelIds: [999] }, /Alert channel 999 does not exist/],
    [{ name: 'x', extra: true }, /Unknown field "extra"/],
  ])('refuses %j', async (body, message) => {
    await expect(createReportSchedule(body, seed.adminId, NOW)).rejects.toThrow(message);
  });

  it('refuses PagerDuty channels for notices', async () => {
    const pd = (await first(ctx.db.insert(schema.alertChannels).values({ name: 'PD', type: 'pagerduty', config: '{"region":"eu"}', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning()))!;
    await expect(createReportSchedule({ name: 'x', channelIds: [pd.id] }, seed.adminId, NOW)).rejects.toThrow(/notices are not sent to PagerDuty/);
  });

  it('generates the evidence pack when due, verifies the chain, sends a notice without report contents, and runs once', async () => {
    const channel = await addEmailChannel();
    const schedule = await createReportSchedule({ name: 'Monthly evidence', channelIds: [channel], reportTypes: ['access_review', 'change_log'] }, seed.adminId, NOW);
    const sent: Notice[] = [];
    const deps = {
      analytics: noAnalytics,
      uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-00000000000${++n}`; })(),
      notice: { deliver: vi.fn(async (_channel: unknown, notice: Notice) => { sent.push(notice); return { ok: true as const, error: null }; }) },
    };
    const due = new Date('2026-11-01T06:01:00.000Z');
    expect(await runDueReportSchedules(new Date('2026-11-01T05:59:00.000Z'), deps)).toBe(0);
    expect(await runDueReportSchedules(due, deps)).toBe(1);
    // Claimed: a second tick at the same time does nothing.
    expect(await runDueReportSchedules(due, deps)).toBe(0);

    const view = await getReportSchedule(schedule.id);
    expect(view).toMatchObject({ lastStatus: 'success', lastError: null, nextRunAt: '2026-12-01T06:00:00.000Z', lastDeliveries: [{ channelId: channel, ok: true }] });
    expect(view.lastReports.map((report) => [report.type, report.scheduleId, report.packId])).toEqual([
      ['access_review', schedule.id, view.lastPackId],
      ['change_log', schedule.id, view.lastPackId],
    ]);
    expect(view.lastReports[0].period).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' });
    expect(view.lastReports[0].generatedBy).toEqual({ userId: null, name: 'Schedule "Monthly evidence"' });

    // Generation is recorded like a report made by hand (by no user), and so is the chain check.
    const actions = vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
    expect(actions.filter((event) => event.action === 'compliance_report_generated')).toHaveLength(2);
    expect(actions.find((event) => event.action === 'compliance_report_generated')).toMatchObject({ userId: null, data: { scheduleId: schedule.id, sha256: view.lastReports[0].sha256 } });
    expect(actions.find((event) => event.action === 'audit_log_verified')).toMatchObject({ userId: null, data: { ok: true, scheduleId: schedule.id } });
    expect(actions.find((event) => event.action === 'compliance_evidence_pack_generated')).toMatchObject({ entityId: schedule.id, data: { status: 'success' } });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: 'compliance_reports_generated', title: 'Monthly evidence: evidence for 2026-10-01 to 2026-10-31' });
    // BASE_URL is "/" under Vite, which is no absolute address to link to.
    expect(sent[0].link === null || sent[0].link.endsWith('/compliance')).toBe(true);
    expect(sent[0].lines[0]).toMatch(/^Access review: .* \(SHA-256 [0-9a-f]{16}…\)$/);
    const text = JSON.stringify(sent[0]);
    for (const leak of ['admin@example.com', 'bob@example.com', 'ci deploy', 'forgotten script']) expect(text).not.toContain(leak);

    expect((await listEvidencePacks()).map((pack) => [pack.packId, pack.reports.length])).toEqual([[view.lastPackId, 2]]);
  });

  it('runs a schedule now over the REST API and lists schedules', async () => {
    const created = await (await schedulesRoute.POST(req('POST', '/api/v1/compliance/schedules', { name: 'Weekly', frequency: 'weekly', weekday: 'friday', reportTypes: ['certificate_inventory'] }))).json();
    expect(created).toMatchObject({ name: 'Weekly', weekday: 'friday', dayOfMonth: null });
    const list = await (await schedulesRoute.GET(req('GET', '/api/v1/compliance/schedules'))).json();
    expect(list.schedules.map((schedule: { name: string }) => schedule.name)).toEqual(['Weekly']);
    const result = await runReportScheduleNow(created.id, seed.adminId, { analytics: noAnalytics });
    expect(result).toMatchObject({ status: 'success', reports: [{ type: 'certificate_inventory', scheduleId: created.id }], deliveries: [] });
    expect(result.reports[0].generatedBy.userId).toBe(seed.adminId);
  });
});

describe('test restores', () => {
  it('are recorded, validated, listed and deleted', async () => {
    const recorded = await recordRestoreTest({ testedAt: '2026-10-01T10:00:00Z', source: 'backup', outcome: 'success', backupObjectKey: 'ingressi-config-2026-10-01T03-00-00Z.json', notes: 'Restored on the spare node.\nAll hosts answered.' }, seed.adminId, NOW);
    expect(recorded).toMatchObject({ testedAt: '2026-10-01T10:00:00.000Z', source: 'backup', outcome: 'success', backupDestination: null, recordedBy: { userId: seed.adminId, name: 'Alice Admin' } });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'compliance_restore_test_recorded', entityId: recorded.id }));

    await expect(recordRestoreTest({ testedAt: '2027-01-01T00:00:00Z', source: 'backup', outcome: 'success' }, seed.adminId, NOW)).rejects.toThrow(/must not be in the future/);
    await expect(recordRestoreTest({ testedAt: '2026-10-01', source: 'tape', outcome: 'success' }, seed.adminId, NOW)).rejects.toThrow(/source must be one of/);
    await expect(recordRestoreTest({ testedAt: '2026-10-01', source: 'backup', outcome: 'meh' }, seed.adminId, NOW)).rejects.toThrow(/outcome must be one of/);
    await expect(recordRestoreTest({ testedAt: '2026-10-01', source: 'backup', outcome: 'success', backupDestinationId: 77 }, seed.adminId, NOW)).rejects.toThrow(/does not name a backup destination/);

    const page = await (await restoreRoute.GET(req('GET', '/api/v1/compliance/restore-tests'))).json();
    expect(page).toMatchObject({ total: 1, tests: [{ id: recorded.id }] });

    await deleteRestoreTest(recorded.id, seed.adminId);
    expect((await listRestoreTests({ page: 1, perPage: 25 })).total).toBe(0);
  });
});

describe('live control status', () => {
  const noManaged = { managedCertificates: async () => ({ available: true, reason: null, certificates: [], unchecked: 0 }) };

  it('checks six controls of the seeded install, with evidence and references', async () => {
    const status = await getControlStatus(NOW, noManaged);
    const byKey = Object.fromEntries(status.controls.map((control) => [control.key, control]));
    expect(Object.keys(byKey)).toEqual(['tls', 'mfa_admins', 'audit_chain', 'backup_restore', 'access_reviews', 'waf_blocking']);
    expect(byKey.tls).toMatchObject({ status: 'not_met', references: { nis2: { ref: 'Art. 21(2)(h)' }, iso27001: { ref: 'A.8.24', title: 'Use of cryptography' } } });
    expect(byKey.tls.checked).toContain('Legacy');
    expect(byKey.mfa_admins).toMatchObject({ status: 'not_met', facts: { administratorsWithoutMfa: ['Bob Admin'] } });
    expect(byKey.audit_chain).toMatchObject({ status: 'attention', statusLabel: 'Not verified' });
    expect(byKey.backup_restore).toMatchObject({ status: 'not_met', statusLabel: 'No test restore', references: { iso27001: { ref: 'A.8.13', title: 'Information backup' } } });
    expect(byKey.access_reviews).toMatchObject({ status: 'not_met' });
    expect(byKey.waf_blocking).toMatchObject({ status: 'not_met' });
    expect(byKey.waf_blocking.checked).toMatch(/Without the WAF: .*Legacy/);
    expect(status.counts).toEqual({ met: 0, attention: 1, not_met: 5, unknown: 0 });
    expect(status.statement).toMatch(/evidence that can support/);
  });

  it('follows the audit chain verifications, test restores and access reviews', async () => {
    const verified = async (at: Date, ok: boolean) => await ctx.db.insert(schema.auditEvents).values({
      action: 'audit_log_verified', entityType: 'audit_log', summary: 'Verified', createdAt: at.toISOString(),
      data: JSON.stringify({ ok, checked: 6418, headHash: '3b9e41d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7f2c07d', firstMismatchId: ok ? null : 12 }),
    });
    await verified(new Date(NOW.getTime() - 2 * 86_400_000), true);
    let status = await getControlStatus(NOW, noManaged);
    expect(status.controls.find((control) => control.key === 'audit_chain')).toMatchObject({ status: 'met', checked: expect.stringContaining('6418 events checked') });
    await verified(new Date(NOW.getTime() - 86_400_000), false);
    status = await getControlStatus(NOW, noManaged);
    expect(status.controls.find((control) => control.key === 'audit_chain')).toMatchObject({ status: 'not_met', checked: expect.stringContaining('at event #12') });

    await ctx.db.insert(schema.backupDestinations).values({
      name: 'Off-site', endpoint: 'https://s3.example.com', region: 'eu', bucket: 'b', accessKeyId: 'k', secretAccessKey: 'x', passphrase: 'x',
      schedule: '{"kind":"daily","time":"03:00"}', lastStatus: 'success', lastSuccessAt: NOW.toISOString(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    await recordRestoreTest({ testedAt: '2026-06-30T10:00:00Z', source: 'backup', outcome: 'success' }, seed.adminId, NOW);
    status = await getControlStatus(NOW, noManaged);
    expect(status.controls.find((control) => control.key === 'backup_restore')).toMatchObject({ status: 'attention', statusLabel: 'Overdue' });
    await recordRestoreTest({ testedAt: '2026-10-02T10:00:00Z', source: 'backup', outcome: 'success' }, seed.adminId, NOW);
    status = await getControlStatus(NOW, noManaged);
    expect(status.controls.find((control) => control.key === 'backup_restore')).toMatchObject({ status: 'met' });

    const campaign = async (values: Partial<typeof schema.accessReviewCampaigns.$inferInsert>) => (await first(ctx.db.insert(schema.accessReviewCampaigns).values({
      name: 'Q3', dueAt: NOW.toISOString(), startedAt: NOW.toISOString(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...values,
    }).returning()))!;
    await campaign({ name: 'Q3 2026', status: 'completed', completedAt: '2026-07-03T10:00:00.000Z' });
    const open = await campaign({ name: 'Q4 2026', status: 'open', dueAt: '2026-10-06T10:00:00.000Z' });
    await ctx.db.insert(schema.accessReviewItems).values({ campaignId: open.id, subjectUserId: seed.adminId, subjectEmail: 'admin@example.com', kind: 'account', targetLabel: 'account', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    status = await getControlStatus(NOW, noManaged);
    expect(status.controls.find((control) => control.key === 'access_reviews')).toMatchObject({ status: 'attention', statusLabel: 'Due in 3 days' });
    status = await getControlStatus(new Date('2026-10-08T00:00:00.000Z'), noManaged);
    expect(status.controls.find((control) => control.key === 'access_reviews')).toMatchObject({ status: 'not_met', statusLabel: 'Overdue' });
  });

  it('is served over the REST API', async () => {
    const response = await statusRoute.GET(req('GET', '/api/v1/compliance/controls/status'));
    expect(response.status).toBe(200);
    expect((await response.json()).controls).toHaveLength(6);
  });
});

describe('incident register', () => {
  const deps = { now: () => NOW, analytics: noAnalytics };

  it('records the window, assessment, classification, cause and timeline', async () => {
    const incident = await createIncident({
      title: 'email.example.com answered 501 to 143 requests',
      detectedAt: '2026-10-03T09:06:00Z',
      startedAt: '2026-10-03T09:01:57Z',
      endedAt: '2026-10-03T09:03:11Z',
      proxyHostIds: [seed.hostWafId],
      assessment: {
        severeDisruption: { answer: 'no', reason: 'one path of one service for 74 seconds' },
        considerableDamage: { answer: 'no', reason: 'no data exposed, changed or lost' },
        suspectedMalicious: { answer: 'no', reason: 'the mail server itself answered 501' },
      },
      classification: 'not_significant',
      timeline: [{ at: '2026-10-03T09:30:00Z', text: 'The mail team fixed the server.' }],
    }, seed.adminId, deps);
    expect(incident).toMatchObject({
      startedAt: '2026-10-03T09:01:57.000Z',
      endedAt: '2026-10-03T09:03:11.000Z',
      classification: 'not_significant',
      classifiedBy: { userId: seed.adminId, name: 'Alice Admin' },
      suggestedClassification: 'not_significant',
      notification: 'not_required',
      closedAt: null,
    });
    expect(incident.assessment.severeDisruption).toEqual({ answer: 'no', reason: 'one path of one service for 74 seconds' });
    expect(incident.assessment.crossBorderImpact).toEqual({ answer: 'unknown', reason: '' });
    // The early warning follows the assessment while its choice is unknown.
    expect(incident.stages.find((stage) => stage.key === 'early_warning')!.fields.suspectedMalicious).toBe('no');
    expect(incident.timeline.map((entry) => [entry.at, entry.source])).toEqual([
      ['2026-10-03T09:06:00.000Z', 'facts'],
      ['2026-10-03T09:30:00.000Z', 'person'],
    ]);

    const summary = (await listIncidents({ page: 1, perPage: 25 })).incidents[0];
    expect(summary).toMatchObject({ classification: 'not_significant', notification: 'not_required', proxyHostCount: 1, startedAt: '2026-10-03T09:01:57.000Z' });
  });

  it('records who reclassified an incident, closes it and keeps it editable', async () => {
    const incident = await createIncident({ title: 'Credential stuffing', detectedAt: '2026-10-02T08:00:00Z' }, seed.adminId, deps);
    expect(incident).toMatchObject({ classification: 'undetermined', classifiedBy: null, notification: 'undetermined' });
    vi.mocked(logAuditEvent).mockClear();
    const updated = await updateIncident(incident.id, {
      assessment: { severeDisruption: { answer: 'yes', reason: 'logins failed for an hour' } },
      classification: 'significant',
      cause: 'Credential stuffing from a botnet.',
      status: 'closed',
    }, seed.adminId, deps);
    expect(updated).toMatchObject({ classification: 'significant', suggestedClassification: 'significant', notification: 'required', cause: 'Credential stuffing from a botnet.', status: 'closed', closedAt: NOW.toISOString() });
    expect(updated.classifiedBy).toEqual({ userId: seed.adminId, name: 'Alice Admin' });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'compliance_incident_classified', data: expect.objectContaining({ classification: 'significant' }) }));

    const reopened = await updateIncident(incident.id, { status: 'open' }, seed.adminId, deps);
    expect(reopened.closedAt).toBeNull();
    expect((await listIncidents({ page: 1, perPage: 25, status: 'closed' })).total).toBe(0);
    expect((await getIncident(incident.id)).cause).toBe('Credential stuffing from a botnet.');
  });

  it.each([
    [{ startedAt: '2026-10-03T10:00:00Z', endedAt: '2026-10-03T09:00:00Z' }, /endedAt must not be before startedAt/],
    [{ classification: 'minor' }, /classification must be one of/],
    [{ assessment: { severeDisruption: { answer: 'maybe' } } }, /assessment.severeDisruption.answer must be one of/],
    [{ assessment: { mood: { answer: 'yes' } } }, /Unknown field "mood"/],
    [{ timeline: [{ at: '2026-10-03T09:00:00Z', text: '' }] }, /timeline\[0\].text is required/],
    [{ timeline: Array.from({ length: 101 }, () => ({ at: '2026-10-03T09:00:00Z', text: 'x' })) }, /at most 100 entries/],
    [{ startedAt: '2099-01-01T00:00:00Z' }, /must not be in the future/],
  ])('refuses %j', async (changes, message) => {
    const incident = await createIncident({ title: 'Outage', detectedAt: '2026-10-02T08:00:00Z' }, seed.adminId, deps);
    await expect(updateIncident(incident.id, changes, seed.adminId, deps)).rejects.toThrow(message);
  });

  it('ignores timeline entries from the facts when a client sends the whole timeline back', async () => {
    const incident = await createIncident({ title: 'Outage', detectedAt: '2026-10-02T08:00:00Z' }, seed.adminId, deps);
    const updated = await updateIncident(incident.id, { timeline: [...incident.timeline, { at: '2026-10-02T09:00:00Z', text: 'Restarted the upstream.' }] }, seed.adminId, deps);
    expect(updated.timeline.filter((entry) => entry.source === 'person').map((entry) => entry.text)).toEqual(['Restarted the upstream.']);
    expect(updated.timeline.filter((entry) => entry.source === 'facts')).toHaveLength(1);
  });

  it('suggests a classification from the deciding answers only', () => {
    const assessment = emptyAssessment();
    expect(suggestedClassification(assessment)).toBe('undetermined');
    assessment.suspectedMalicious.answer = 'yes';
    expect(suggestedClassification(assessment)).toBe('undetermined');
    assessment.severeDisruption.answer = 'no';
    assessment.considerableDamage.answer = 'no';
    expect(suggestedClassification(assessment)).toBe('not_significant');
    assessment.considerableDamage.answer = 'yes';
    expect(suggestedClassification(assessment)).toBe('significant');
  });
});
