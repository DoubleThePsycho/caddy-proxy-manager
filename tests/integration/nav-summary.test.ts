/**
 * The sidebar's counters (src/lib/nav-summary.ts) against an in-memory
 * database: each one only for the read permission of the page it points to,
 * scoped like that page, and never a reason for the dashboard to fail.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

import * as schema from '../../src/lib/db/schema';
import { adminAccess, builtInAccess, type Access, type Permission } from '../../src/lib/permissions';
import { getNavSummary, reviewsBadge } from '../../src/lib/nav-summary';
import { createSelfSignedServerCertificate } from '../helpers/certs';

const DAY = 86_400_000;
const NONE = { pending: 0, dueAt: null, overdue: false };
const stamp = () => new Date().toISOString();

function role(permissions: Permission[], scopeTags: string[] = [], organizationId: number | null = null): Access {
  return {
    userId: 7,
    role: 'viewer',
    isAdmin: false,
    customRole: { id: 1, name: 'Custom' },
    permissions: new Set(permissions),
    scopeTags,
    organizationId,
  };
}

let expiringPem: string;
let laterPem: string;

beforeAll(() => {
  expiringPem = createSelfSignedServerCertificate('soon.example.com', ['soon.example.com'], 5).certificatePem;
  laterPem = createSelfSignedServerCertificate('later.example.com', ['later.example.com'], 200).certificatePem;
});

beforeEach(async () => {
  for (const table of [schema.alertRuleStates, schema.alertRules, schema.certificates, schema.changeRequests, schema.proxyHosts, schema.settings]) {
    await ctx.db.delete(table);
  }
});

async function addCertificate(name: string, pem: string, organizationId: number | null = null) {
  const [row] = await ctx.db
    .insert(schema.certificates)
    .values({ name, type: 'imported', domainNames: JSON.stringify([`${name}.example.com`]), certificatePem: pem, privateKeyPem: 'x', createdAt: stamp(), updatedAt: stamp(), organizationId })
    .returning();
  return row.id;
}

async function addFiringAlert(enabled = true) {
  const [rule] = await ctx.db
    .insert(schema.alertRules)
    .values({ name: `Rule ${Math.random()}`, type: 'cert_expiring', enabled, createdAt: stamp(), updatedAt: stamp() })
    .returning();
  await ctx.db.insert(schema.alertRuleStates).values({ ruleId: rule.id, subjectKey: 'cert:1', status: 'firing', firedAt: stamp(), lastEvaluatedAt: stamp() });
}

async function addChangeRequest(status: string, tags: string[] = [], requestedBy = 99) {
  await ctx.db.insert(schema.changeRequests).values({
    targetType: 'proxy_host',
    targetId: 1,
    targetName: 'app.example.com',
    operation: 'update',
    input: '{}',
    tags: JSON.stringify(tags),
    status,
    requestedBy,
    expiresAt: new Date(Date.now() + DAY).toISOString(),
    createdAt: stamp(),
    updatedAt: stamp(),
  });
}

describe('nav summary', () => {
  it('shows administrators every counter that has something to count', async () => {
    await addFiringAlert();
    await addFiringAlert(false);
    await addCertificate('soon', expiringPem);
    await addCertificate('later', laterPem);
    await addChangeRequest('pending');
    await addChangeRequest('pending');
    await addChangeRequest('applied');

    const { badges } = await getNavSummary(adminAccess(1), NONE);
    expect(badges.alertsFiring).toMatchObject({ text: '1', tone: 'warn', label: '1 alert firing' });
    expect(badges.certificatesExpiring).toMatchObject({ text: '1', tone: 'warn', label: '1 certificate expiring within 14 days' });
    expect(badges.approvalsPending).toMatchObject({ text: '2', tone: 'neutral', label: '2 change requests waiting' });
    expect(badges.reviewsDue).toBeNull();
  });

  it('counts nothing a role cannot read', async () => {
    await addFiringAlert();
    await addCertificate('soon', expiringPem);
    await addChangeRequest('pending');
    for (const access of [builtInAccess(2, 'user'), builtInAccess(3, 'viewer'), role(['proxy_hosts:read'])]) {
      const summary = await getNavSummary(access, NONE);
      expect(summary.badges.alertsFiring ?? null).toBeNull();
      expect(summary.badges.certificatesExpiring ?? null).toBeNull();
      expect(summary.environment).toBeNull();
      expect(summary.badges.licenseNodes ?? null).toBeNull();
    }
    // proxy_hosts:read without approvals:read: still no approvals counter.
    expect((await getNavSummary(role(['proxy_hosts:read']), NONE)).badges.approvalsPending ?? null).toBeNull();
  });

  it('counts only the change requests a role may see', async () => {
    await addChangeRequest('pending', ['prod']);
    await addChangeRequest('pending', ['staging']);
    const scoped = role(['approvals:read', 'proxy_hosts:read'], ['staging']);
    expect((await getNavSummary(scoped, NONE)).badges.approvalsPending?.text).toBe('1');
    // Without proxy_hosts:read a role only sees its own requests.
    const own = { ...role(['approvals:read']), userId: 99 };
    expect((await getNavSummary(own, NONE)).badges.approvalsPending?.text).toBe('2');
    expect((await getNavSummary(role(['approvals:read']), NONE)).badges.approvalsPending ?? null).toBeNull();
  });

  it('counts an organisation user only their organisation\'s certificates', async () => {
    await addCertificate('mine', expiringPem, 5);
    await addCertificate('theirs', expiringPem, 6);
    await addCertificate('provider', expiringPem, null);
    const member = role(['certificates:read'], [], 5);
    expect((await getNavSummary(member, NONE)).badges.certificatesExpiring?.text).toBe('1');
    expect((await getNavSummary(adminAccess(1), NONE)).badges.certificatesExpiring?.text).toBe('3');
  });

  it('describes the reviewer\'s own open reviews', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(reviewsBadge(NONE, now)).toBeNull();
    expect(reviewsBadge({ pending: 2, dueAt: '2026-10-06T12:00:00Z', overdue: false }, now)).toEqual({
      text: '3d',
      tone: 'warn',
      label: '2 review items to decide, due in 3 days',
    });
    expect(reviewsBadge({ pending: 1, dueAt: '2026-11-03T12:00:00Z', overdue: false }, now)).toMatchObject({ text: '31d', tone: 'neutral' });
    expect(reviewsBadge({ pending: 1, dueAt: '2026-10-01T12:00:00Z', overdue: true }, now)).toMatchObject({ text: 'Late', tone: 'warn' });
    expect(reviewsBadge({ pending: 4, dueAt: null, overdue: false }, now)).toMatchObject({ text: '4' });
  });

  it('shows instance readers where this instance stands', async () => {
    const summary = await getNavSummary(role(['instances:read', 'settings:read']), NONE);
    expect(summary.environment).toMatchObject({ mode: 'standalone', name: 'This server', tone: 'ok', environments: [], links: { fleet: false, sync: true } });
  });

  it('has no edition without a valid license', async () => {
    const summary = await getNavSummary(adminAccess(1), NONE);
    expect(summary.edition).toBeNull();
    expect(summary.badges.licenseNodes ?? null).toBeNull();
  });
});
