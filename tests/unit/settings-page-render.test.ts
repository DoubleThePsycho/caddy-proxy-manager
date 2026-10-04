/**
 * The Settings page's groups: the catalog shared with the command palette
 * (every old section id still opens the group that took it in), the save
 * bar's change count, and a server-side render of the page in its main
 * states (default group, deep links, replica wording, read-only analytics,
 * branding outside the MSP edition, restricted groups).
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const searchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/settings',
  useSearchParams: () => searchParams,
}));
// Server actions are not called by a render; stubs keep the database and Caddy out of it.
vi.mock('../../app/(dashboard)/settings/actions', () => ({
  updateGeneralSettingsAction: vi.fn(),
  updateDefaultResponseSettingsAction: vi.fn(),
  updateAcmeSettingsAction: vi.fn(),
  updateDnsProviderSettingsAction: vi.fn(),
  updateDnsSettingsAction: vi.fn(),
  createSlaveInstanceAction: vi.fn(),
  deleteSlaveInstanceAction: vi.fn(),
  pinSlaveSyncKeyAction: vi.fn(),
  resetSlaveSyncKeyPinAction: vi.fn(),
  syncSlaveInstancesAction: vi.fn(),
  toggleSlaveInstanceAction: vi.fn(),
  updateInstanceModeAction: vi.fn(),
  updateSlaveInstanceAction: vi.fn(),
  updateSlaveMasterTokenAction: vi.fn(),
  updateTrustedProxiesSettingsAction: vi.fn(),
  updateUpstreamDnsResolutionSettingsAction: vi.fn(),
  updateAuthentikSettingsAction: vi.fn(),
  updateErrorPagesSettingsAction: vi.fn(),
  updateForwardAuthSettingsAction: vi.fn(),
  updateGeoBlockSettingsAction: vi.fn(),
  updateRateLimitSettingsAction: vi.fn(),
  updateLoggingSettingsAction: vi.fn(),
  updateMetricsSettingsAction: vi.fn(),
  createOAuthProviderAction: vi.fn(),
  updateOAuthProviderAction: vi.fn(),
  deleteOAuthProviderAction: vi.fn(),
}));
vi.mock('@/ee/high-availability/ui/certificate-storage-actions', () => ({
  saveCertificateStorageAction: vi.fn(),
  removeCertificateStorageAction: vi.fn(),
  testCertificateStorageAction: vi.fn(),
}));
vi.mock('@/ee/high-availability/ui/shared-state-actions', () => ({
  saveSharedStateAction: vi.fn(),
  removeSharedStateAction: vi.fn(),
  sharedStateStatusAction: vi.fn(async () => ({ ok: true, status: { backend: 'local', reachable: null, error: null, keys: null, drain: null, leader: true } })),
}));
vi.mock('../../app/(dashboard)/settings/usage-ping-actions', () => ({
  setUsagePingEnabledAction: vi.fn(),
  resetUsagePingInstallIdAction: vi.fn(),
}));

import SettingsClient from '../../app/(dashboard)/settings/SettingsClient';
import type { SettingsClientProps } from '../../app/(dashboard)/settings/types';
import { countChanges } from '@/src/components/settings/settings-form';
import {
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_ALIASES,
  SETTINGS_SECTION_GROUPS,
  findSettingsSection,
  resolveSettingsSection,
} from '../../src/lib/settings-sections';
import { GEOIP_ASN_DB, GEOIP_COUNTRY_DB, getGeoIpDatabases, getGeoIpStatus } from '../../src/lib/geoip-status';
import type { UsagePingView } from '../../src/lib/usage-ping/store';

/** Every id `/settings?section=` accepted before the groups were merged. */
const OLD_SECTION_IDS = [
  'sync', 'general', 'acme', 'default-response', 'usage-ping', 'certificate-storage',
  'dns-providers', 'dns-resolvers', 'upstream-dns', 'trusted-proxies',
  'geoblock', 'rate-limit', 'error-pages', 'authentik', 'forward-auth', 'oauth',
  'metrics', 'logging',
];

describe('settings groups catalog', () => {
  it('keeps every old section id working', () => {
    for (const id of OLD_SECTION_IDS) {
      expect(resolveSettingsSection(id), id).not.toBeNull();
    }
    expect(resolveSettingsSection('dns-providers')).toMatchObject({ section: { id: 'acme' }, anchor: 'settings-dns-providers' });
    expect(resolveSettingsSection('logging')).toMatchObject({ section: { id: 'analytics' }, anchor: 'settings-access-log' });
    expect(resolveSettingsSection('default-response')).toMatchObject({ section: { id: 'general' }, anchor: 'settings-unknown-hosts' });
    expect(resolveSettingsSection('general')).toMatchObject({ section: { id: 'general' }, anchor: null });
    expect(resolveSettingsSection('nope')).toBeNull();
  });

  it('points every card at a group that exists, and keeps ids unique', () => {
    const ids = SETTINGS_SECTION_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const alias of SETTINGS_SECTION_ALIASES) {
      expect(findSettingsSection(alias.section), alias.id).toBeDefined();
      expect(ids).not.toContain(alias.id);
    }
  });

  it('lists groups and cards for the palette with the permission they need', () => {
    const byId = new Map(SETTINGS_SECTIONS.map((section) => [section.id, section]));
    expect(byId.get('sync')?.permission).toBe('instances:read');
    expect(byId.get('oauth')?.permission).toBe('sso:read');
    expect(byId.get('backups')?.permission).toBe('backups:read');
    expect(byId.get('certificate-storage')?.permission).toBe('high_availability:read');
    expect(byId.get('high-availability')?.permission).toBe('high_availability:read');
    expect(byId.get('shared-state')?.permission).toBe('high_availability:read');
    expect(resolveSettingsSection('shared-state')).toMatchObject({ section: { id: 'high-availability' }, anchor: 'settings-shared-state' });
    // Branding has its own palette entry (the /branding page).
    expect(byId.has('branding')).toBe(false);
    expect(byId.get('dns-providers')?.groupLabel).toBe('Certificates and ACME');
  });
});

describe('save bar change count', () => {
  it('counts each field name whose values differ', () => {
    const initial = new Map([['primaryDomain', ['a.example.com']], ['enabled', []], ['mode', ['caddy']]]);
    expect(countChanges(initial, new Map(initial))).toBe(0);
    expect(countChanges(initial, new Map([...initial, ['primaryDomain', ['b.example.com']]]))).toBe(1);
    // A switch turned on, and a field that appeared.
    expect(countChanges(initial, new Map([...initial, ['enabled', ['on']], ['status', ['404']]]))).toBe(2);
  });
});

describe('GeoIP status helper', () => {
  it('reports both databases with their paths', () => {
    const status = getGeoIpStatus();
    expect(typeof status.country).toBe('boolean');
    expect(typeof status.asn).toBe('boolean');
    expect(getGeoIpDatabases().map((database) => database.path)).toEqual([GEOIP_COUNTRY_DB, GEOIP_ASN_DB]);
  });
});

const usagePing = {
  status: 'unanswered',
  enabled: false,
  disabledByEnv: false,
  role: 'master',
  endpoint: 'https://ping.example.com/v1/ping',
  endpointError: null,
  installId: null,
  answeredAt: null,
  answeredBy: null,
  nextAttemptAt: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastResult: null,
  lastError: null,
  pendingErasures: 0,
  payload: { schema: 1 },
} as unknown as UsagePingView;

function props(overrides: Partial<SettingsClientProps> = {}): SettingsClientProps {
  return {
    general: { primaryDomain: 'example.com', acmeEmail: 'admin@example.com' },
    acme: null,
    dnsProvider: null,
    dnsProviderDefinitions: [],
    authentik: null,
    forwardAuth: null,
    metrics: null,
    logging: { enabled: true, format: 'json' },
    dns: null,
    upstreamDnsResolution: null,
    trustedProxies: null,
    defaultResponse: null,
    oauthProviders: [],
    baseUrl: 'https://dashboard.example.com',
    usagePing,
    canWriteSettings: true,
    instanceSync: {
      mode: 'master',
      modeFromEnv: false,
      tokenFromEnv: false,
      overrides: {
        general: false, acme: false, dnsProvider: false, authentik: false, forwardAuth: false, metrics: false,
        logging: false, dns: false, upstreamDnsResolution: false, trustedProxies: false, defaultResponse: false,
      },
      slave: null,
      master: { instances: [], envInstances: [], orphanSyncKeyPins: [] },
    },
    geoip: [
      { name: 'GeoLite2 Country', path: GEOIP_COUNTRY_DB, found: true, updatedAt: '2026-10-01T03:00:00.000Z' },
      { name: 'GeoLite2 ASN', path: GEOIP_ASN_DB, found: false, updatedAt: null },
    ],
    analytics: { enabled: true, retentionDays: 30, retentionFromEnv: false, totals: null, totalsError: null },
    backups: { allowed: true, configurable: false, editionLabel: 'Business', destinations: [] },
    branding: { licensed: false, canRead: true, editionLabel: 'MSP' },
    links: { history: true, certificates: true, fleet: true },
    ...overrides,
  };
}

function render(overrides: Partial<SettingsClientProps> = {}): string {
  return renderToStaticMarkup(createElement(SettingsClient, props(overrides)))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('Settings page', () => {
  it('opens on General with its cards, the group list and one save bar', () => {
    const html = render();
    expect(html).toContain('<h1');
    expect(html).toMatch(/<h2 id="settings-group-general"[^>]*>General<\/h2>/);
    expect(html).toContain('Primary domain');
    expect(html).toContain('https://dashboard.example.com');
    expect(html).toContain('Requests for unknown hosts');
    expect(html).toContain('Close the connection');
    expect(html.match(/data-testid="settings-save-bar"/g)).toHaveLength(1);
    expect(html).toContain('No unsaved changes.');
    // The group list with its sections and notes.
    for (const label of ['System', 'Networking', 'Security defaults', 'Observability', 'Appearance']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('Search settings');
    expect(html).toContain('href="/history"');
    // The contact e-mail moved to Certificates and ACME; General only carries it along.
    expect(html).toContain('<input type="hidden" data-untracked="" name="acmeEmail" value="admin@example.com"/>');
  });

  it('opens the group an old section id now lives in', () => {
    const html = render({ initialSection: 'dns-providers' });
    expect(html).toMatch(/<h2 id="settings-group-acme"[^>]*>Certificates and ACME<\/h2>/);
    expect(html).toContain('id="settings-dns-providers"');
    expect(html).toContain('No DNS provider yet');
    expect(html).toContain('Contact e-mail');
    expect(html).not.toMatch(/<h2 id="settings-group-general"/);
  });

  it('says replica, never slave, while keeping the stored mode value', () => {
    const html = render({ initialSection: 'sync' });
    expect(html).toContain('>Replica<');
    expect(html).toContain('<input type="hidden" name="mode" value="master"/>');
    expect(html).toContain('No replicas yet');
    expect(html).not.toMatch(/>[^<]*\bslaves?\b[^<]*</i);
  });

  it('shows ClickHouse and its retention read-only, with totals only when given', () => {
    const without = render({ initialSection: 'analytics' });
    expect(without).toContain('Keep events for');
    expect(without).toContain('30 days');
    expect(without).toContain('CLICKHOUSE_RETENTION_DAYS');
    expect(without).not.toContain('Unique addresses');
    expect(without).toContain('http://ingressi-caddy:9090/metrics');

    const withTotals = render({
      initialSection: 'analytics',
      analytics: { enabled: true, retentionDays: 30, retentionFromEnv: true, totals: { requests: 2_980_000, wafEvents: 30_545, bytes: 41.9e9, uniqueAddresses: 10_896 }, totalsError: null },
    });
    expect(withTotals).toContain('Unique addresses');
    expect(withTotals).toContain('30,545');
  });

  it('shows the GeoIP databases found and missing', () => {
    const html = render({ initialSection: 'geoblock' });
    expect(html).toContain(GEOIP_COUNTRY_DB);
    expect(html).toContain('Missing');
    expect(html).toContain('GeoLite2 ASN is missing');
  });

  it('shows branding locked outside the MSP edition, and a link with it', () => {
    const locked = render({ initialSection: 'branding' });
    expect(locked).toContain('Branding is part of the MSP edition.');
    expect(locked).toContain('href="/license"');
    const licensed = render({ initialSection: 'branding', branding: { licensed: true, canRead: true, editionLabel: 'MSP' } });
    expect(licensed).not.toContain('Branding is part of the MSP edition.');
    expect(licensed).toContain('Open branding');
  });

  it('summarises backups and links to where they are set up', () => {
    const html = render({ initialSection: 'backups' });
    expect(html).toContain('No backup destination yet');
    expect(html).toContain('href="/history?tab=backups"');
    const restricted = render({ initialSection: 'backups', backups: { allowed: false, configurable: false, editionLabel: 'Business', destinations: [] } });
    expect(restricted).toContain('backups:read');
  });

  it('shows a notice instead of groups the role cannot read', () => {
    const html = render({ initialSection: 'sync', restricted: { sync: true, oauth: true } });
    expect(html).toContain('instances:read');
    expect(html).not.toContain('Instance mode');
  });

  it('shows the dashboard cluster, or how to set one up', () => {
    const off = render({
      initialSection: 'high-availability',
      cluster: {
        view: { enabled: false, configurable: false, error: null, node: null, lease: null, replication: null, lastRestore: null, nodes: [], config: null },
        editionLabel: 'Enterprise',
      },
    });
    expect(off).toMatch(/<h2 id="settings-group-high-availability"[^>]*>High availability<\/h2>/);
    expect(off).toContain('High availability is off on this node');
    expect(off).toContain('ee/docs/high-availability.md');

    const now = '2026-10-03T10:00:00.000Z';
    const on = render({
      initialSection: 'high-availability',
      cluster: {
        editionLabel: 'Enterprise',
        view: {
          enabled: true,
          configurable: true,
          error: null,
          node: { id: 'web-1', role: 'leader', startedAt: now, statusUpdatedAt: now },
          lease: { holder: 'web-1', epoch: 7, ttlSeconds: 15, checkedAt: now, error: null },
          replication: { replicaId: 'e7-0a1b2c3d', lastSyncAt: now, lagSeconds: 1, error: null, checkedAt: now },
          lastRestore: { at: now, ok: true, source: 'replica', replicaId: 'e6-99887766', durationMs: 2400, error: null },
          nodes: [
            { id: 'web-1', role: 'leader', epoch: 7, follow: null, lastRestore: null, updatedAt: now },
            { id: 'web-2', role: 'standby', epoch: null, follow: { replicaId: 'e7-0a1b2c3d', ready: true, error: null }, lastRestore: null, updatedAt: now },
          ],
          config: {
            redis: { mode: 'standalone', addresses: ['valkey.example.com:6379'], keyPrefix: 'ingressi-ha', tls: false, hasPassword: true },
            storage: { endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'ingressi-ha', path: 'ingressi' },
            leaseTtlSeconds: 15,
            syncIntervalSeconds: 1,
            followIntervalSeconds: 5,
          },
        },
      },
    });
    expect(on).toContain('Dashboard cluster');
    expect(on).toContain('Epoch 7');
    expect(on).toContain('e7-0a1b2c3d');
    expect(on).toContain('Restored from the newest replica');
    expect(on).toContain('web-2');
    expect(on).toContain('Ready');
    expect(on).not.toContain('Replication is behind');

    const restricted = render({ initialSection: 'high-availability', restricted: { sync: false, oauth: false, certificateStorage: true } });
    expect(restricted).toContain('high_availability:read');
  });

  it('cannot save without settings:write', () => {
    const html = render({ canWriteSettings: false });
    expect(html).toContain('Your role can read these settings but not change them.');
  });
});
