import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock all dependencies of the server action before importing it.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/src/lib/auth', () => ({
  requirePermission: vi.fn(() => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireAdmin())),
  requireAdmin: vi.fn(async () => ({ user: { id: '1' } })),
}));

type CreateExclusionMock = (input: { ruleId: number; proxyHostId: number | null; reason?: string }, userId: number, options: unknown) => Promise<object>;

const { listProxyHostsMock, createExclusionMock, listExclusionsMock } = vi.hoisted(() => ({
  listProxyHostsMock: vi.fn(async () => [] as unknown[]),
  // Suppressing a rule for a host adds a whole-host exclusion record.
  createExclusionMock: vi.fn<CreateExclusionMock>(async () => ({})),
  listExclusionsMock: vi.fn(async () => [] as { path: string | null; variable: string | null }[]),
}));

vi.mock('@/src/lib/models/proxy-hosts', () => ({
  listProxyHosts: listProxyHostsMock,
  updateProxyHost: vi.fn(),
}));
vi.mock('@/src/lib/models/waf-exclusions', () => ({
  createWafExclusion: createExclusionMock,
  deleteWafExclusion: vi.fn(),
  listWafExclusions: listExclusionsMock,
}));

// Stub other transitive deps of actions.ts that we don't exercise.
vi.mock('@/src/lib/caddy', () => ({ applyCaddyConfig: vi.fn() }));
vi.mock('@/src/lib/instance-sync', () => ({
  getInstanceMode: vi.fn(),
  getSlaveMasterToken: vi.fn(),
  setInstanceMode: vi.fn(),
  setSlaveMasterToken: vi.fn(),
  syncInstances: vi.fn(),
}));
vi.mock('@/src/lib/models/instances', () => ({
  createInstance: vi.fn(),
  deleteInstance: vi.fn(),
  updateInstance: vi.fn(),
}));
vi.mock('@/src/lib/settings', () => ({
  clearSetting: vi.fn(),
  getSetting: vi.fn(),
  saveCloudflareSettings: vi.fn(),
  getDnsProviderSettings: vi.fn(),
  saveDnsProviderSettings: vi.fn(),
  saveGeneralSettings: vi.fn(),
  saveAuthentikSettings: vi.fn(),
  saveMetricsSettings: vi.fn(),
  saveLoggingSettings: vi.fn(),
  saveDnsSettings: vi.fn(),
  saveUpstreamDnsResolutionSettings: vi.fn(),
  saveGeoBlockSettings: vi.fn(),
  saveWafSettings: vi.fn(),
  getWafSettings: vi.fn(),
}));
vi.mock('@/src/lib/models/waf-events', () => ({
  getWafRuleMessages: vi.fn(),
}));
vi.mock('@/src/lib/dns-providers', () => ({
  getProviderDefinition: vi.fn(),
  encryptProviderCredentials: vi.fn(),
}));

import { suppressWafRuleForHostAction } from '@/app/(dashboard)/settings/actions';

beforeEach(() => {
  createExclusionMock.mockClear();
  listExclusionsMock.mockClear();
  listProxyHostsMock.mockClear();
});

describe('suppressWafRuleForHostAction port normalization', () => {
  const fakeHost = {
    id: 42,
    domains: ['app.example.com'],
    waf: { enabled: true, waf_mode: 'merge' as const, excluded_rule_ids: [] as number[] },
  };

  it('matches a host when the hostname has no port', async () => {
    listProxyHostsMock.mockResolvedValueOnce([fakeHost]);
    const result = await suppressWafRuleForHostAction(941100, 'app.example.com');
    expect(result.success).toBe(true);
    expect(createExclusionMock).toHaveBeenCalledTimes(1);
    expect(createExclusionMock.mock.calls[0]![0]).toMatchObject({ ruleId: 941100, proxyHostId: 42 });
  });

  it('matches a host when the hostname includes :443 (regression)', async () => {
    // Caddy/Coraza records the Host header verbatim, which can include the port
    // when clients send "Host: app.example.com:443" (HTTP/2 :authority, some HTTP/1.1
    // clients). The action must strip the port before matching against
    // host.domains, which stores bare domain names.
    listProxyHostsMock.mockResolvedValueOnce([fakeHost]);
    const result = await suppressWafRuleForHostAction(941100, 'app.example.com:443');
    expect(result.success).toBe(true);
    expect(createExclusionMock).toHaveBeenCalledTimes(1);
    expect(createExclusionMock.mock.calls[0]![0]).toMatchObject({ ruleId: 941100, proxyHostId: 42 });
  });

  it('matches a host when the hostname includes an arbitrary port', async () => {
    listProxyHostsMock.mockResolvedValueOnce([fakeHost]);
    const result = await suppressWafRuleForHostAction(941100, 'app.example.com:8443');
    expect(result.success).toBe(true);
    expect(createExclusionMock).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 941100, proxyHostId: 42, reason: 'Suppressed from a WAF event' }),
      1,
    );
  });

  it('returns an error when no host matches even after port stripping', async () => {
    listProxyHostsMock.mockResolvedValueOnce([fakeHost]);
    const result = await suppressWafRuleForHostAction(941100, 'other.example.com:443');
    expect(result.success).toBe(false);
    expect(result.message).toContain('No proxy host found');
    expect(createExclusionMock).not.toHaveBeenCalled();
  });

  it('adds nothing when the rule is already excluded for the whole host', async () => {
    listProxyHostsMock.mockResolvedValueOnce([fakeHost]);
    listExclusionsMock.mockResolvedValueOnce([{ path: null, variable: null }]);
    const result = await suppressWafRuleForHostAction(941100, 'app.example.com:443');
    expect(result.success).toBe(true);
    expect(listExclusionsMock).toHaveBeenCalledWith({ proxyHostId: 42, ruleId: 941100 });
    expect(createExclusionMock).not.toHaveBeenCalled();
  });

  it('still adds a whole-host exclusion when only a narrower one exists', async () => {
    listProxyHostsMock.mockResolvedValueOnce([fakeHost]);
    listExclusionsMock.mockResolvedValueOnce([{ path: '/api/', variable: null }]);
    const result = await suppressWafRuleForHostAction(941100, 'app.example.com');
    expect(result.success).toBe(true);
    expect(createExclusionMock).toHaveBeenCalledTimes(1);
  });
});
