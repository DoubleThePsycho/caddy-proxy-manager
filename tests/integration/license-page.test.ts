/**
 * The license page against a real (in-memory) database: what "On this
 * install" reports for each paid feature (and that its details follow the
 * viewer's permissions), the verify step (license:write, stores nothing),
 * and the rendered page for each license state.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { createTestSigner, licensePayload, signLicense } from '../helpers/license';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('@/src/lib/auth', () => ({ requirePermission: vi.fn() }));
vi.mock('@/src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { requirePermission } from '@/src/lib/auth';
import { adminAccess, type Access, type Permission } from '@/src/lib/permissions';
import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { getLicenseState, LICENSE_SETTING_KEY } from '@/ee/licensing/store';
import { evaluateLicense, GRACE_PERIOD_DAYS as SERVER_GRACE_DAYS } from '@/ee/licensing/license';
import { getFeatureUsage } from '@/ee/licensing/usage';
import { toLicenseView } from '@/ee/licensing/view';
import { verifyLicenseAction } from '@/ee/licensing/ui/actions';
import LicensePage from '@/app/(dashboard)/license/page';
import LicenseClient, { licenseEndPhases } from '@/ee/licensing/ui/LicenseClient';
import { describeCheck, keyFromFileText } from '@/ee/licensing/ui/InstallKeyCard';
import {
  GRACE_PERIOD_DAYS,
  editionGroupLabel,
  featureRows,
  formatDay,
  formatDayRange,
  nextDay,
  releaseLine,
} from '@/ee/licensing/ui/license-format';
import { first } from '@/src/lib/db/ops';

const signer = createTestSigner('2026-test');
const NOW = '2026-10-03T12:00:00.000Z';

function at(): string {
  return new Date().toISOString();
}

async function storeKey(key: string) {
  await ctx.db.insert(schema.settings).values({ key: LICENSE_SETTING_KEY, value: JSON.stringify(key), updatedAt: at() });
}

async function storedKey(): Promise<string | null> {
  const row = await first(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, LICENSE_SETTING_KEY)).limit(1));
  return row ? JSON.parse(row.value) : null;
}

function key(overrides: Record<string, unknown> = {}): string {
  return signLicense(signer, licensePayload(signer, { edition: 'enterprise', nodes: 20, iat: '2026-01-01T00:00:00.000Z', exp: '2099-12-31T00:00:00.000Z', ...overrides }));
}

function customAccess(permissions: Permission[]): Access {
  return {
    userId: 2,
    role: 'viewer',
    isAdmin: false,
    customRole: { id: 1, name: 'License readers' },
    permissions: new Set(permissions),
    scopeTags: [],
    organizationId: null,
  };
}

async function seedAlertFiring() {
  const rule = (await first(ctx.db
    .insert(schema.alertRules)
    .values({ name: 'Certificates', type: 'certificate_expiry', enabled: true, createdAt: at(), updatedAt: at() })
    .returning()))!;
  await ctx.db
    .insert(schema.alertRuleStates)
    .values({ ruleId: rule.id, subjectKey: 'cert:1', status: 'firing', firedAt: at(), lastEvaluatedAt: at() });
}

async function seedFleetEnvironment(name = 'Production', position = 0) {
  await ctx.db.insert(schema.fleetEnvironments).values({ name, position, createdAt: at(), updatedAt: at() });
}

function evaluateEnterprise() {
  return evaluateLicense(key(), signer.keys, new Date(NOW));
}

async function viewOf(licenseKey: string | null, now = new Date(NOW)) {
  if (licenseKey) await storeKey(licenseKey);
  return toLicenseView(await getLicenseState(now), 3);
}

beforeEach(() => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  setTrustedLicenseKeysForTests(signer.keys);
  vi.mocked(requirePermission).mockResolvedValue({ user: { id: '1' }, access: adminAccess(1) } as never);
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('getFeatureUsage', () => {
  it('reports nothing in use on a fresh install, and nothing to set up for air-gapped installs', async () => {
    const usage = await getFeatureUsage(adminAccess(1));
    expect(usage.air_gap).toEqual({ inUse: null, detail: null });
    for (const [feature, value] of Object.entries(usage)) {
      if (feature !== 'air_gap') expect(value, feature).toEqual({ inUse: false, detail: null });
    }
  });

  it('marks set-up features in use, with details for viewers who may read the area', async () => {
    await seedAlertFiring();
    await seedFleetEnvironment('Production', 0);
    await seedFleetEnvironment('Staging', 1);
    const usage = await getFeatureUsage(adminAccess(1));
    expect(usage.alerting).toEqual({ inUse: true, detail: '1 firing' });
    expect(usage.fleet).toEqual({ inUse: true, detail: '2 environments' });
    expect(usage.ldap.inUse).toBe(false);
  });

  it('leaves the details out for a role that only reads the license', async () => {
    await seedAlertFiring();
    await seedFleetEnvironment();
    const usage = await getFeatureUsage(customAccess(['license:read']));
    expect(usage.alerting).toEqual({ inUse: true, detail: null });
    expect(usage.fleet).toEqual({ inUse: true, detail: null });
    const withFleet = await getFeatureUsage(customAccess(['license:read', 'fleet:read']));
    expect(withFleet.fleet.detail).toBe('1 environment');
    expect(withFleet.alerting.detail).toBeNull();
  });
});

describe('verifyLicenseAction', () => {
  it('needs license:write and says what the key grants without storing it', async () => {
    const installed = key({ id: 'LIC-INSTALLED', edition: 'business' });
    await storeKey(installed);
    const candidate = key({ id: 'LIC-NEW', customer: 'Example S.r.l.' });
    const result = await verifyLicenseAction(candidate);
    expect(requirePermission).toHaveBeenCalledWith('license:write');
    expect(result).toMatchObject({
      ok: true,
      check: { installable: true, status: 'active', edition: 'enterprise', licenseId: 'LIC-NEW', keyId: '2026-test', nodes: 20, error: null },
    });
    expect('check' in result && result.check.features).toContain('fleet');
    expect(JSON.stringify(result)).not.toContain(candidate);
    expect(await storedKey()).toBe(installed);
  });

  it('refuses without the permission', async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error('denied'));
    await expect(verifyLicenseAction(key())).rejects.toThrow('denied');
  });

  it('reports invalid, expired and not-yet-valid keys as not installable', async () => {
    const invalid = await verifyLicenseAction('v1.not.valid');
    expect(invalid).toMatchObject({ ok: true, check: { installable: false, status: 'invalid', error: 'The license key is not valid', edition: null } });
    const expired = await verifyLicenseAction(key({ iat: '2020-01-01T00:00:00.000Z', exp: '2021-01-01T00:00:00.000Z' }));
    expect(expired).toMatchObject({ ok: true, check: { installable: false, status: 'expired', error: 'This license expired on 2021-01-01' } });
    const future = await verifyLicenseAction(key({ iat: '2098-01-01T00:00:00.000Z' }));
    expect(future).toMatchObject({ ok: true, check: { installable: false, status: 'invalid', error: 'The license key is not valid yet' } });
    const other = createTestSigner('other');
    const foreign = await verifyLicenseAction(signLicense(other, licensePayload(other)));
    expect(foreign).toMatchObject({ ok: true, check: { installable: false, error: 'The license key was signed by an unknown key' } });
    expect(await storedKey()).toBeNull();
  });

  it('accepts a key in its grace period', async () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const result = await verifyLicenseAction(key({ iat: '2025-01-01T00:00:00.000Z', exp: recent }));
    expect(result).toMatchObject({ ok: true, check: { installable: true, status: 'grace' } });
  });

  it('rejects empty and oversized input before checking', async () => {
    expect(await verifyLicenseAction('   ')).toEqual({ error: 'Paste a license key or choose a key file' });
    expect(await verifyLicenseAction(`v1.${'a'.repeat(20_000)}.b`)).toEqual({ error: 'That is too long for a license key' });
  });
});

describe('LicensePage', () => {
  it('renders the installed license, its key id and what is in use, never the key', async () => {
    const installed = key({ id: 'LIC-PAGE', customer: 'Example S.r.l.' });
    await storeKey(installed);
    await seedFleetEnvironment();
    const html = renderToStaticMarkup(await LicensePage());
    expect(requirePermission).toHaveBeenCalledWith('license:read');
    expect(html).toContain('Administration');
    expect(html).toContain('Current license');
    expect(html).toContain('Enterprise');
    expect(html).toContain('Verified offline');
    expect(html).toContain('LIC-PAGE');
    expect(html).toContain('2026-test');
    expect(html).toContain('Your edition');
    expect(html).toContain('In use');
    expect(html).toContain('1 environment');
    expect(html).toContain('Remove key');
    expect(html).toContain('Verify key');
    expect(html).not.toContain(installed);
  });

  it('hides installing and removing from a role that only reads the license', async () => {
    await storeKey(key());
    vi.mocked(requirePermission).mockResolvedValue({ user: { id: '2' }, access: customAccess(['license:read']) } as never);
    const html = renderToStaticMarkup(await LicensePage());
    expect(html).not.toContain('Remove key');
    expect(html).not.toContain('Verify key');
    expect(html).toContain('Your role can see the license but not change it');
  });
});

describe('LicenseClient', () => {
  function render(props: Parameters<typeof LicenseClient>[0]) {
    return renderToStaticMarkup(createElement(LicenseClient, { now: NOW, trustedKeyIds: ['2026-10'], ...props }));
  }

  it('shows Community with the built-in key and every feature as not licensed', async () => {
    const html = render({ license: await viewOf(null) });
    expect(html).toContain('Community');
    expect(html).toContain('No license');
    expect(html).toContain('Keys are checked on this machine');
    expect(html).toContain('2026-10');
    expect(html).toContain('Not licensed');
    expect(html).toContain('Get a license or a 14-day trial');
    expect(html).not.toContain('Remove key');
    expect(html).not.toContain('Your edition');
  });

  it('shows the renewal and grace dates of an active license', async () => {
    const html = render({ license: await viewOf(key({ exp: '2026-12-31T00:00:00.000Z' })) });
    expect(html).toContain('Active');
    expect(html).toContain('31 Dec 2026');
    expect(html).toContain('30 Jan 2027');
    expect(html).toContain('In <span class="num">89</span> days.');
    expect(html).toContain('1 Jan to 30 Jan 2027');
    expect(html).toContain('From 31 Jan 2027');
    expect(html).toContain('Not in Enterprise');
    expect(html).toContain('Renew or upgrade');
  });

  it('warns during the grace period and marks it as now', async () => {
    const license = await viewOf(key({ exp: '2026-09-20T00:00:00.000Z' }));
    expect(license.status).toBe('grace');
    const html = render({ license });
    expect(html).toContain('Grace period');
    expect(html).toContain('The license expired on 20 Sept 2026.');
    expect(licenseEndPhases(license).map((phase) => phase.current)).toEqual([false, true, false]);
  });

  it('shows features in use as read-only once the license has expired', async () => {
    const license = await viewOf(key({ iat: '2024-01-01T00:00:00.000Z', exp: '2025-01-01T00:00:00.000Z' }));
    expect(license.status).toBe('expired');
    const html = render({ license, usage: { fleet: { inUse: true, detail: null } } });
    expect(html).toContain('License expired');
    expect(html).toContain('read-only');
    expect(licenseEndPhases(license).map((phase) => phase.current)).toEqual([false, false, true]);
  });

  it('explains an invalid stored key', async () => {
    await storeKey('v1.garbage.key');
    const html = render({ license: toLicenseView(await getLicenseState(new Date(NOW)), 1) });
    expect(html).toContain('Invalid key');
    expect(html).toContain('The license key is not valid');
    expect(html).toContain('Remove key');
  });
});

describe('license page helpers', () => {
  it('keeps the grace period in step with the server', () => {
    expect(GRACE_PERIOD_DAYS).toBe(SERVER_GRACE_DAYS);
  });

  it('reads the release line from a release version only', () => {
    expect(releaseLine('2.0.3')).toEqual({ version: '2.0.3', line: '2.0' });
    expect(releaseLine('v1.14.2-rc.1')).toEqual({ version: '1.14.2-rc.1', line: '1.14' });
    expect(releaseLine('3f2a9c1')).toEqual({ version: '3f2a9c1', line: null });
    expect(releaseLine('')).toEqual({ version: 'unknown', line: null });
  });

  it('formats days and ranges in UTC', () => {
    expect(formatDay('2026-12-31T23:30:00.000Z')).toBe('31 Dec 2026');
    expect(formatDayRange(nextDay('2026-12-31T00:00:00.000Z'), new Date('2027-01-30T00:00:00.000Z'))).toBe('1 Jan to 30 Jan 2027');
    expect(formatDayRange(new Date('2026-12-20T00:00:00.000Z'), new Date('2027-01-19T00:00:00.000Z'))).toBe('20 Dec 2026 to 19 Jan 2027');
  });

  it('labels the edition groups from the catalogue', () => {
    expect(editionGroupLabel('homelab', ['alerting', 'config_history', 'ai_analyst'])).toBe('Homelab and up');
    expect(editionGroupLabel('business', ['sso_saml'])).toBe('Business and up');
    expect(editionGroupLabel('enterprise', ['fleet', 'ldap'])).toBe('Enterprise only');
    expect(editionGroupLabel('msp', ['multi_tenancy', 'white_label'])).toBe('MSP only');
  });

  it('sorts each feature into in use, not set up, nothing to set up or out', async () => {
    const license = await viewOf(key({ edition: 'business' }));
    const rows = featureRows(license, {
      alerting: { inUse: true, detail: '1 firing' },
      config_history: { inUse: false, detail: null },
      multi_tenancy: { inUse: true, detail: null },
      air_gap: { inUse: null, detail: null },
    });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.alerting).toMatchObject({ install: 'use', detail: '1 firing' });
    expect(byId.config_history.install).toBe('idle');
    // Set up while licensed for it, not in this edition: running, read-only.
    expect(byId.multi_tenancy).toMatchObject({ install: 'use', detail: 'read-only' });
    expect(byId.fleet.install).toBe('out');
    expect(byId.air_gap.install).toBe('out');
    const enterpriseRows = featureRows(toLicenseView(evaluateEnterprise(), 1), { air_gap: { inUse: null, detail: null } });
    const enterprise = Object.fromEntries(enterpriseRows.map((row) => [row.id, row]));
    expect(enterprise.air_gap.install).toBe('included');
    expect(enterprise.fleet.install).toBe('idle');
  });

  it('lists virtual patching as coming soon, granted by Enterprise but not configurable', () => {
    const view = toLicenseView(evaluateEnterprise(), 1);
    expect(view.features.find((feature) => feature.id === 'virtual_patching')).toMatchObject({ available: false, included: true, configurable: false });
    const rows = Object.fromEntries(featureRows(view, { virtual_patching: { inUse: true, detail: '1 patch on' } }).map((row) => [row.id, row]));
    expect(rows.virtual_patching).toMatchObject({ install: 'soon', detail: null });
  });

  it('takes the key out of a key file and describes what a checked key grants', async () => {
    expect(keyFromFileText('Your key:\n\nv1.abc_DEF-1.sig-2_x\n\nThanks')).toBe('v1.abc_DEF-1.sig-2_x');
    expect(keyFromFileText('  not a key  ')).toBe('not a key');
    const result = await verifyLicenseAction(key({ edition: 'business', nodes: 2, features: ['fleet'], customer: 'Example S.r.l.' }));
    if (!('check' in result)) throw new Error('expected a check');
    const text = describeCheck(result.check, { hasLicense: true, nodesUsed: 3, inUse: ['multi_tenancy'] });
    expect(text.tone).toBe('ok');
    expect(text.title).toBe('Signature verified with public key 2026-test');
    expect(text.body).toContain('Business · 2 nodes · Example S.r.l. · valid until 31 Dec 2099');
    expect(text.body).toContain('replaces the current key');
    expect(text.notes.join(' ')).toContain('Also grants Fleet management.');
    expect(text.notes.join(' ')).toContain('Not in this key but set up here: Multi-tenancy');
    expect(text.notes.join(' ')).toContain('the key covers 2');
  });
});
