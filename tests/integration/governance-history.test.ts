/**
 * Audit events linked to configuration history versions
 * (ee/config-history/links.ts), versions with titles and sizes, comparing
 * two versions, the rollback preview (ee/config-history/versions.ts) and the
 * audit log's filters, details and diffs (src/lib/models/audit.ts and the
 * REST routes), on a real in-memory database.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { installLicense, licenseSigner, now, seedConfiguration, setSettingRow, type Fixture } from '../helpers/config-fixture';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return {
    ...actual,
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  };
});

const { logAuditEvent } = await vi.importActual<typeof import('../../src/lib/audit')>('../../src/lib/audit');

import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { recordConfigSnapshotAfterApply } from '../../ee/config-history/snapshots';
import { createManualSnapshot, updateHistorySettings } from '../../ee/config-history/service';
import { HISTORY_SETTING_KEY } from '../../ee/config-history/settings';
import { auditEventConfigDiff, compareVersions, listVersions, previewRollback } from '../../ee/config-history/versions';
import { configEntityOf, describeChangeSize } from '../../ee/config-history/changes';
import { approvedChangeStorage } from '../../ee/approvals/context';
import { builtInAccess } from '../../src/lib/permissions';
import { countAuditEventsMatching, listAuditFacets, queryAuditEvents } from '../../src/lib/models/audit';
import * as auditEventRoute from '../../app/api/v1/audit-log/[id]/route';
import * as versionsRoute from '../../app/api/v1/config-history/versions/route';
import * as compareRoute from '../../app/api/v1/config-history/compare/route';
import * as previewRoute from '../../app/api/v1/config-history/[id]/rollback-preview/route';
import { asc, first as dbFirst } from '@/src/lib/db/ops';

let fx: Fixture;

beforeEach(async () => {
  ctx.db = createTestDb();
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  fx = await seedConfiguration(ctx.db);
});

afterAll(() => setTrustedLicenseKeysForTests(null));

async function enableHistory(): Promise<number> {
  await setSettingRow(ctx.db, HISTORY_SETTING_KEY, { enabled: true, retention: 200 });
  await recordConfigSnapshotAfterApply();
  return await latestSnapshotId();
}

async function latestSnapshotId(): Promise<number> {
  return (await ctx.db.select({ id: schema.configSnapshots.id }).from(schema.configSnapshots).orderBy(asc(schema.configSnapshots.id))).pop()!.id;
}

async function lastEvent() {
  return (await ctx.db.select().from(schema.auditEvents).orderBy(asc(schema.auditEvents.id))).pop()!;
}

async function setUpstreams(upstreams: string[]): Promise<void> {
  await ctx.db.update(schema.proxyHosts).set({ upstreams: JSON.stringify(upstreams), updatedAt: now() }).where(eq(schema.proxyHosts.id, fx.hostId));
}

/** A change made the way the model functions make it: audit event first, then the apply records the version. */
async function changeHost(upstreams: string[], summary: string, userId = fx.adminId): Promise<{ eventId: number; versionId: number }> {
  await setUpstreams(upstreams);
  await logAuditEvent({ userId, action: 'update', entityType: 'proxy_host', entityId: fx.hostId, summary });
  const eventId = (await lastEvent()).id;
  await recordConfigSnapshotAfterApply();
  return { eventId, versionId: await latestSnapshotId() };
}

const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
const get = (path: string) => new NextRequest(`http://localhost${path}`);

describe('which audit events are configuration changes', () => {
  it('maps entities to configuration tables and leaves checks, exports and other areas out', () => {
    expect(configEntityOf({ action: 'update', entityType: 'proxy_host', entityId: 3 })).toEqual({ kind: 'row', table: 'proxyHosts', id: 3 });
    expect(configEntityOf({ action: 'update', entityType: 'setting', entityId: null })).toEqual({ kind: 'settings', key: null });
    expect(configEntityOf({ action: 'certificate_storage_updated', entityType: 'certificate_storage' })).toEqual({ kind: 'settings', key: 'certificate_storage' });
    expect(configEntityOf({ action: 'config_imported', entityType: 'configuration' })).toEqual({ kind: 'all' });
    expect(configEntityOf({ action: 'config_exported', entityType: 'configuration' })).toBeNull();
    expect(configEntityOf({ action: 'certificate_storage_tested', entityType: 'certificate_storage' })).toBeNull();
    expect(configEntityOf({ action: 'mfa_policy_updated', entityType: 'setting' })).toBeNull();
    expect(configEntityOf({ action: 'login_success', entityType: 'session' })).toBeNull();
    expect(configEntityOf({ action: 'alert_rule_updated', entityType: 'alert_rule', entityId: 1 })).toBeNull();
  });
});

describe('audit events linked to versions', () => {
  it('links a change to the version before it and the version its apply recorded', async () => {
    const first = await enableHistory();
    const { eventId, versionId } = await changeHost(['backend-v2:8080'], 'Changed the upstream of App');
    const event = (await dbFirst(ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, eventId)).limit(1)))!;
    expect(versionId).toBeGreaterThan(first);
    expect(event).toMatchObject({ configBeforeId: first, configAfterId: versionId, changeRequestId: null });
    // Links are not part of the hash: the chain still verifies.
    const { verifyAuditChain } = await import('../../ee/audit/verify');
    expect((await verifyAuditChain()).ok).toBe(true);
  });

  it('keeps an event pending until its apply, and shows only its own entity in the diff', async () => {
    await enableHistory();
    await setUpstreams(['backend-v3:8080']);
    await logAuditEvent({ userId: fx.adminId, action: 'update', entityType: 'proxy_host', entityId: fx.hostId, summary: 'Changed the upstream of App' });
    const pending = await lastEvent();
    expect(pending.configBeforeId).not.toBeNull();
    expect(pending.configAfterId).toBeNull();

    // Another change lands in the same version; the event's diff leaves it out.
    await ctx.db.update(schema.accessLists).set({ name: 'Staff renamed', updatedAt: now() }).where(eq(schema.accessLists.id, fx.listId));
    await recordConfigSnapshotAfterApply();
    const linked = (await dbFirst(ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, pending.id)).limit(1)))!;
    expect(linked.configAfterId).toBe(await latestSnapshotId());

    const diff = await auditEventConfigDiff(linked);
    expect(diff).toMatchObject({ available: true, filtered: true, beforeId: pending.configBeforeId, afterId: linked.configAfterId });
    expect(diff!.groups.map((group) => [group.entity, group.id])).toEqual([['proxyHosts', fx.hostId]]);
    expect(diff!.groups[0].fields).toEqual([{ path: 'upstreams', before: ['backend:8080'], after: ['backend-v3:8080'] }]);
  });

  it('matches an event recorded after its apply (settings saves) to the version that apply stored', async () => {
    const before = await enableHistory();
    await setSettingRow(ctx.db, 'general', { primaryDomain: 'example.org', acmeEmail: 'acme@example.com' });
    await recordConfigSnapshotAfterApply();
    const after = await latestSnapshotId();
    await logAuditEvent({ userId: fx.adminId, action: 'update', entityType: 'setting', summary: 'Updated general settings' });
    expect(await lastEvent()).toMatchObject({ configBeforeId: before, configAfterId: after });

    const diff = await auditEventConfigDiff(await lastEvent());
    expect(diff!.groups).toEqual([
      expect.objectContaining({ entity: 'settings', id: 'general', kind: 'changed', fields: [{ path: 'primaryDomain', before: 'example.com', after: 'example.org' }] }),
    ]);

    // A second save without a change of its own is not matched to that version again.
    await logAuditEvent({ userId: fx.adminId, action: 'update', entityType: 'setting', summary: 'Updated general settings' });
    expect(await lastEvent()).toMatchObject({ configBeforeId: after, configAfterId: null });
  });

  it('closes a pending event as "no change" when the apply finds the configuration unchanged', async () => {
    const version = await enableHistory();
    await logAuditEvent({ userId: fx.adminId, action: 'update', entityType: 'proxy_host', entityId: fx.hostId, summary: 'Saved App without changes' });
    await recordConfigSnapshotAfterApply();
    const event = await lastEvent();
    expect(event).toMatchObject({ configBeforeId: version, configAfterId: version });
    expect(await auditEventConfigDiff(event)).toMatchObject({ available: true, groups: [], reason: 'The change left the configuration as it was.' });
  });

  it('records no versions while history is off, and drops pending events when it is turned off', async () => {
    await logAuditEvent({ userId: fx.adminId, action: 'update', entityType: 'proxy_host', entityId: fx.hostId, summary: 'History is off' });
    expect(await lastEvent()).toMatchObject({ configBeforeId: null, configAfterId: null });
    expect(await auditEventConfigDiff(await lastEvent())).toBeNull();

    await installLicense(ctx.db);
    await enableHistory();
    await logAuditEvent({ userId: fx.adminId, action: 'update', entityType: 'proxy_host', entityId: fx.hostId, summary: 'Pending' });
    const pendingId = (await lastEvent()).id;
    await updateHistorySettings({ enabled: false }, fx.adminId);
    expect(await dbFirst(ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, pendingId)).limit(1))).toMatchObject({ configBeforeId: null, configAfterId: null });
  });

  it('names the change request whose approved change recorded the event', async () => {
    await enableHistory();
    await approvedChangeStorage.run({ targetType: 'proxy_host', targetId: fx.hostId, requestId: 42 }, async () => {
      await logAuditEvent({ userId: fx.memberId, action: 'update', entityType: 'proxy_host', entityId: fx.hostId, summary: 'Approved change' });
    });
    expect((await lastEvent()).changeRequestId).toBe(42);
    await logAuditEvent({ userId: fx.memberId, action: 'update', entityType: 'proxy_host', entityId: fx.hostId, summary: 'Direct change' });
    expect((await lastEvent()).changeRequestId).toBeNull();
  });

  it('reports versions retention deleted as no longer available', async () => {
    await enableHistory();
    const { eventId } = await changeHost(['backend-v2:8080'], 'Changed the upstream of App');
    await ctx.db.delete(schema.configSnapshots);
    const event = (await dbFirst(ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, eventId)).limit(1)))!;
    expect(await auditEventConfigDiff(event)).toMatchObject({ available: false, groups: [], reason: 'The configuration history no longer keeps these versions.' });
  });
});

describe('versions', () => {
  it('titles versions from their audit events and says how big each change was', async () => {
    const first = await enableHistory();
    const change = await changeHost(['backend-v2:8080'], 'Changed the upstream of App');
    await installLicense(ctx.db);
    const manual = await createManualSnapshot(fx.adminId, { summary: 'Before the upgrade' });

    const list = await listVersions();
    const byId = new Map(list.versions.map((version) => [version.id, version]));
    expect(list.total).toBe(3);
    expect(list.recording).toEqual({ enabled: true, retention: 200 });
    expect(byId.get(first)).toMatchObject({ size: 'First version', titleSource: 'summary' });
    expect(byId.get(change.versionId)).toMatchObject({
      title: 'Changed the upstream of App',
      titleSource: 'audit',
      size: '1 host · 1 field',
      actors: [{ userId: fx.adminId, name: 'Admin' }],
      auditEventIds: [change.eventId],
      touched: { hosts: [{ type: 'proxy_host', id: fx.hostId, label: 'App' }], settings: [] },
    });
    expect(byId.get(manual.id)).toMatchObject({ title: 'Before the upgrade', titleSource: 'note', size: 'No changes', live: true });
    expect(list.liveId).toBe(manual.id);

    // A change that is not recorded yet: the newest version is no longer live.
    await setUpstreams(['unrecorded:1']);
    expect((await listVersions()).liveId).toBeNull();
  });

  it('computes the changes of versions recorded before changes were stored, once', async () => {
    await enableHistory();
    await changeHost(['backend-v2:8080'], 'Changed the upstream of App');
    await ctx.db.update(schema.configSnapshots).set({ changes: null, previousId: null });
    const versions = (await listVersions()).versions;
    expect(versions[0]).toMatchObject({ size: '1 host · 1 field' });
    const stored = await ctx.db.select({ changes: schema.configSnapshots.changes }).from(schema.configSnapshots);
    expect(stored.every((row) => row.changes !== null)).toBe(true);
  });

  it('describes change sizes in words', () => {
    const totals = (overrides: Record<string, number>) => ({ totals: { items: 0, fields: 0, hosts: 0, hostsAdded: 0, hostsRemoved: 0, settings: 0, other: 0, ...overrides } });
    expect(describeChangeSize(totals({}))).toBe('No changes');
    expect(describeChangeSize({ ...totals({}), initial: true })).toBe('First version');
    expect(describeChangeSize(totals({ items: 1, hosts: 1, hostsAdded: 1 }))).toBe('1 host added');
    expect(describeChangeSize(totals({ items: 3, hosts: 2, fields: 4 }))).toBe('2 hosts · 4 fields');
    expect(describeChangeSize(totals({ items: 2, settings: 1, other: 1, fields: 2 }))).toBe('1 settings group · 1 other item · 2 fields');
    expect(describeChangeSize(totals({ items: 1, other: 1 }))).toBe('1 item');
  });

  it('compares two versions field by field, naming referenced rows', async () => {
    const first = await enableHistory();
    const other = (await dbFirst(ctx.db.insert(schema.accessLists).values({ name: 'Media admins', createdAt: now(), updatedAt: now() }).returning()))!;
    await ctx.db.update(schema.proxyHosts).set({ accessListId: other.id, updatedAt: now() }).where(eq(schema.proxyHosts.id, fx.hostId));
    await recordConfigSnapshotAfterApply();
    const second = await latestSnapshotId();

    const comparison = await compareVersions(String(first), String(second));
    expect(comparison.from).toEqual({ kind: 'snapshot', id: first });
    expect(comparison.to).toEqual({ kind: 'snapshot', id: second });
    const host = comparison.groups.find((group) => group.entity === 'proxyHosts')!;
    expect(host).toMatchObject({ id: fx.hostId, label: 'App', kind: 'changed', host: { type: 'proxy_host', id: fx.hostId, label: 'App' } });
    expect(host.fields).toEqual([{ path: 'accessListId', before: fx.listId, after: other.id, beforeLabel: 'Staff', afterLabel: 'Media admins' }]);
    const added = comparison.groups.find((group) => group.entity === 'accessLists')!;
    expect(added).toMatchObject({ kind: 'added', label: 'Media admins' });
    expect(added.fields.map((field) => field.path)).toContain('name');
    expect(added.fields.map((field) => field.path)).not.toContain('id');
    expect(comparison.totals).toMatchObject({ added: 1, changed: 1, removed: 0 });

    // "previous" is relative to the version on the other side.
    expect((await compareVersions('previous', String(second))).from).toEqual({ kind: 'snapshot', id: first });
    expect((await compareVersions('previous', String(first))).from).toEqual({ kind: 'empty' });
    await expect(compareVersions('current', 'previous')).rejects.toThrow(/to must be/);
    await expect(compareVersions('abc', 'current')).rejects.toThrow(/from and to must be/);
  });

  it('never returns a secret in a comparison', async () => {
    const first = await enableHistory();
    await setSettingRow(ctx.db, 'dns_provider', { providers: { cloudflare: { api_token: 'plain-new-token-SECRET' } }, default: 'cloudflare' });
    await recordConfigSnapshotAfterApply();
    const comparison = await compareVersions(String(first), 'current');
    expect(JSON.stringify(comparison)).not.toContain('SECRET');
    expect(JSON.stringify(comparison)).toContain('"secret":true');
  });
});

describe('rollback preview', () => {
  it('lists the hosts that change, the later changes it undoes and later changes to the same host', async () => {
    await enableHistory();
    const a = await changeHost(['backend-a:8080'], 'Changed the upstream of App to a');
    const b = await changeHost(['backend-b:8080'], 'Changed the upstream of App to b', fx.memberId);

    const preview = await previewRollback(a.versionId, builtInAccess(fx.adminId, 'admin'));
    expect(preview.identical).toBe(false);
    expect(preview.hosts).toEqual([{ type: 'proxy_host', id: fx.hostId, name: 'App', kind: 'changed', fields: ['upstreams'] }]);
    expect(preview.undoes.map((version) => version.id)).toEqual([b.versionId]);
    expect(preview.sameHostWarnings).toEqual([
      expect.objectContaining({ versionId: b.versionId, title: 'Changed the upstream of App to b', hosts: ['App'], actors: [{ userId: fx.memberId, name: 'Member' }] }),
    ]);
    expect(preview.reload).toEqual({ nodes: 1, instances: [], heldBack: [] });
    expect(preview.blocked).toBeNull();
    // No license installed.
    expect(preview.canRestore).toBe(false);
    expect(preview.reasons).toEqual(['Rolling back needs a license that includes configuration history.']);

    await installLicense(ctx.db);
    expect(await previewRollback(a.versionId, builtInAccess(fx.adminId, 'admin'))).toMatchObject({ canRestore: true, reasons: [] });
    expect((await previewRollback(a.versionId, builtInAccess(fx.memberId, 'user'))).reasons).toEqual(['Rolling back needs the config_history:restore permission.']);
  });

  it('says when the version is the running configuration', async () => {
    await installLicense(ctx.db);
    await enableHistory();
    const { versionId } = await changeHost(['backend-a:8080'], 'Changed the upstream of App');
    const preview = await previewRollback(versionId);
    expect(preview).toMatchObject({ identical: true, hosts: [], undoes: [], canRestore: false });
    expect(preview.reasons).toContain('This version matches the running configuration: rolling back would change nothing.');
  });

  it('refuses when an approval policy protects a host the rollback changes, naming the policy', async () => {
    await installLicense(ctx.db);
    const first = await enableHistory();
    await changeHost(['backend-a:8080'], 'Changed the upstream of App');
    await ctx.db.insert(schema.approvalPolicies).values({ name: 'Production', createdAt: now(), updatedAt: now() });
    const preview = await previewRollback(first, builtInAccess(fx.adminId, 'admin'));
    expect(preview.blocked).toMatchObject({ hosts: [{ type: 'proxy_host', id: fx.hostId, name: 'App', operations: ['update'], policies: [{ name: 'Production' }] }] });
    expect(preview.canRestore).toBe(false);
    expect(preview.reasons.join(' ')).toMatch(/Protected by an approval policy: proxy host "App"/);
  });

  it('counts the slave instances that reload on a master', async () => {
    await enableHistory();
    const { versionId } = await changeHost(['backend-a:8080'], 'Changed');
    await setSettingRow(ctx.db, 'instance_mode', 'master');
    const preview = await previewRollback(versionId);
    // The fixture's enabled instance "replica" is synced to.
    expect(preview.reload).toEqual({ nodes: 2, instances: ['replica'], heldBack: [] });
  });
});

describe('audit log filters and details', () => {
  beforeEach(async () => {
    await ctx.db.delete(schema.auditEvents);
  });

  it('filters by actor, action, entity, time and text, newest first', async () => {
    await logAuditEvent({ userId: fx.adminId, action: 'update', entityType: 'proxy_host', entityId: fx.hostId, summary: 'Changed App' });
    await logAuditEvent({ userId: fx.memberId, action: 'create', entityType: 'access_list', entityId: fx.listId, summary: 'Created Staff 100%' });
    await logAuditEvent({ userId: null, action: 'audit_log_pruned', entityType: 'audit_log', summary: 'Pruned' });

    const summaries = async (filter: Parameters<typeof queryAuditEvents>[0]) => (await queryAuditEvents(filter, { limit: 50, offset: 0 })).map((event) => event.summary);
    expect(await summaries({})).toEqual(['Pruned', 'Created Staff 100%', 'Changed App']);
    expect(await summaries({ actor: fx.memberId })).toEqual(['Created Staff 100%']);
    expect(await summaries({ actor: 'system' })).toEqual(['Pruned']);
    expect(await summaries({ action: 'update' })).toEqual(['Changed App']);
    expect(await summaries({ entityType: 'access_list', entityId: fx.listId })).toEqual(['Created Staff 100%']);
    expect(await summaries({ search: '100%' })).toEqual(['Created Staff 100%']);
    expect(await summaries({ search: '%' })).toEqual(['Created Staff 100%']);
    expect(await summaries({ from: '2999-01-01T00:00:00.000Z' })).toEqual([]);
    expect(await countAuditEventsMatching({ to: '2000-01-01T00:00:00.000Z' })).toBe(0);
    expect(await countAuditEventsMatching({})).toBe(3);

    const [event] = await queryAuditEvents({ action: 'update' }, { limit: 1, offset: 0 });
    expect(event).toMatchObject({ user: { id: fx.adminId, name: 'Admin', email: 'admin@example.com' }, configChange: null });
    expect(event.hash).toMatch(/^[0-9a-f]{64}$/);

    const facets = await listAuditFacets();
    expect(facets.actions).toEqual(['audit_log_pruned', 'create', 'update']);
    expect(facets.entityTypes).toEqual(['access_list', 'audit_log', 'proxy_host']);
    expect(facets.actors.map((actor) => actor.id).sort()).toEqual([fx.adminId, fx.memberId, null].sort());
  });

  it('serves an event with its configuration diff over the REST API', async () => {
    await enableHistory();
    const { eventId, versionId } = await changeHost(['backend-v2:8080'], 'Changed the upstream of App');
    const response = await auditEventRoute.GET(get(`/api/v1/audit-log/${eventId}`), params(eventId));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ id: eventId, configChange: { afterId: versionId, pending: false }, configDiff: { available: true, filtered: true } });
    expect(body.configDiff.groups[0].fields[0]).toMatchObject({ path: 'upstreams' });
    expect(body).not.toHaveProperty('configBeforeId');

    expect((await auditEventRoute.GET(get('/api/v1/audit-log/abc'), params('abc'))).status).toBe(404);
    expect((await auditEventRoute.GET(get('/api/v1/audit-log/99999'), params(99999))).status).toBe(404);
  });

  it('serves versions, comparisons and previews over the REST API', async () => {
    const first = await enableHistory();
    const { versionId } = await changeHost(['backend-v2:8080'], 'Changed the upstream of App');
    const list = await (await versionsRoute.GET(get('/api/v1/config-history/versions?limit=1'))).json();
    expect(list).toMatchObject({ total: 2, limit: 1, versions: [{ id: versionId, title: 'Changed the upstream of App' }] });
    expect((await versionsRoute.GET(get('/api/v1/config-history/versions?limit=-1'))).status).toBe(400);

    const comparison = await (await compareRoute.GET(get(`/api/v1/config-history/compare?from=${first}&to=${versionId}`))).json();
    expect(comparison.groups).toHaveLength(1);
    expect((await compareRoute.GET(get('/api/v1/config-history/compare?from=1;drop'))).status).toBe(400);

    const preview = await (await previewRoute.GET(get(`/api/v1/config-history/${first}/rollback-preview`), params(first))).json();
    expect(preview).toMatchObject({ identical: false, hosts: [{ name: 'App' }] });
    expect((await previewRoute.GET(get('/api/v1/config-history/999/rollback-preview'), params(999))).status).toBe(404);
  });
});
