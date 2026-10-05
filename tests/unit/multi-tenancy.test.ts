/**
 * Multi-tenancy (ee/multi-tenancy): the pure parts. The organisation
 * permissions, allowed upstreams, domain clashes and certificate names, the
 * analytics host mapping, usage periods and CSV, and the view and filter
 * parameters.
 */
import { describe, expect, it } from 'vitest';
import forge from 'node-forge';
import {
  ADMIN_LEVEL_PERMISSIONS,
  isAdminLevel,
  ORGANIZATION_PERMISSIONS,
  organizationAccess,
  PERMISSION_AREAS,
  PERMISSIONS,
  can,
  type Permission,
} from '@/src/lib/permissions';
import { normalizeAllowedUpstreams, upstreamRefusal } from '@/ee/multi-tenancy/upstreams';
import { certificatePemNames, namesClash } from '@/ee/multi-tenancy/domains';
import { hostMatchesDomains, storedHostName } from '@/ee/multi-tenancy/analytics';
import { parseUsagePeriod, usageReportCsv, type UsageReport } from '@/ee/multi-tenancy/usage';
import { formatOrganizationView, parseOrganizationView } from '@/ee/multi-tenancy/view';
import { inTenant, organizationFilterFor, readOrganizationFilterParam } from '@/ee/multi-tenancy/scope';
import { slugFromName } from '@/ee/multi-tenancy/service';
import { grantOfBuiltInRole } from '@/ee/custom-roles/escalation';

/** Areas organisation users may never touch: everything instance-wide or the provider's. */
const PROVIDER_AREAS = [
  'settings', 'instances', 'fleet', 'waf', 'l4_proxy_hosts', 'config', 'config_history', 'import', 'backups',
  'license', 'sso', 'mfa_policy', 'ldap', 'scim', 'access_reviews', 'branding', 'audit_streaming', 'monetization',
  'alerts', 'ai', 'compliance', 'approvals', 'organizations', 'high_availability',
];

describe('organisation permissions', () => {
  it('hold nothing instance-wide or administrator-level', () => {
    expect(isAdminLevel(ORGANIZATION_PERMISSIONS)).toBe(false);
    for (const permission of ORGANIZATION_PERMISSIONS) {
      expect(ADMIN_LEVEL_PERMISSIONS).not.toContain(permission);
      expect(PROVIDER_AREAS).not.toContain(permission.split(':')[0]);
    }
    // Every catalogue area is either an organisation area or a provider area.
    const organizationAreas = new Set(ORGANIZATION_PERMISSIONS.map((permission) => permission.split(':')[0]));
    for (const area of Object.keys(PERMISSION_AREAS)) {
      expect(organizationAreas.has(area) || PROVIDER_AREAS.includes(area), area).toBe(true);
    }
  });

  it('cut any role down to them and never make an administrator', () => {
    const everything = organizationAccess(7, 3, 'viewer', { id: 1, name: 'All', permissions: [...PERMISSIONS], scopeTags: [] });
    expect(everything.isAdmin).toBe(false);
    expect(everything.organizationId).toBe(3);
    expect([...everything.permissions].sort()).toEqual([...ORGANIZATION_PERMISSIONS].sort());
    expect(can(everything, 'settings:write')).toBe(false);
    expect(can(everything, 'organizations:read')).toBe(false);

    const asAdmin = organizationAccess(7, 3, 'admin');
    expect(asAdmin.isAdmin).toBe(false);
    expect(asAdmin.permissions.size).toBe(0);

    const orgAdmin = organizationAccess(7, 3, 'org_admin');
    expect([...orgAdmin.permissions].sort()).toEqual([...ORGANIZATION_PERMISSIONS].sort());
    expect(organizationAccess(7, 3, 'user').permissions.size).toBe(0);
  });

  it('make org_admin a grant only of organisation permissions', () => {
    const grant = grantOfBuiltInRole('org_admin');
    expect(grant.isAdmin).toBe(false);
    expect([...grant.permissions].every((permission) => ORGANIZATION_PERMISSIONS.includes(permission as Permission))).toBe(true);
  });
});

describe('scope helpers', () => {
  it('let provider-level callers see every row and organisation users only theirs', () => {
    expect(inTenant({ organizationId: null }, 5)).toBe(true);
    expect(inTenant({ organizationId: 5 }, 5)).toBe(true);
    expect(inTenant({ organizationId: 5 }, 6)).toBe(false);
    expect(inTenant({ organizationId: 5 }, null)).toBe(false);
    expect(inTenant({}, null)).toBe(true);
    expect(organizationFilterFor({ organizationId: 5 }, 6)).toBe(5);
    expect(organizationFilterFor({ organizationId: null }, 6)).toBe(6);
  });

  it('read ?organizationId=, which organisation users cannot change', () => {
    expect(readOrganizationFilterParam({ organizationId: null }, null)).toBeUndefined();
    expect(readOrganizationFilterParam({ organizationId: null }, 'provider')).toBeNull();
    expect(readOrganizationFilterParam({ organizationId: null }, '12')).toBe(12);
    expect(() => readOrganizationFilterParam({ organizationId: null }, '1; drop')).toThrow(/organizationId/);
    expect(readOrganizationFilterParam({ organizationId: 4 }, '12')).toBe(4);
    expect(readOrganizationFilterParam({ organizationId: 4 }, 'provider')).toBe(4);
  });

  it('round-trip the switcher cookie', () => {
    for (const view of [undefined, null, 7]) expect(parseOrganizationView(formatOrganizationView(view))).toBe(view);
    expect(parseOrganizationView('garbage')).toBeUndefined();
  });

  it('derive slugs from names', () => {
    expect(slugFromName('Acme Corp. (EU)')).toBe('acme-corp-eu');
    expect(slugFromName('Café Zürich')).toBe('cafe-zurich');
    expect(slugFromName('***')).toBe('');
  });
});

describe('allowed upstreams', () => {
  const patterns = normalizeAllowedUpstreams(['*.alpha.example.com', 'API.example.org', '10.1.0.0/16', '2001:db8::/32', '192.0.2.7']);

  it('validates and normalises the list', () => {
    expect(patterns).toEqual(['*.alpha.example.com', '10.1.0.0/16', '192.0.2.7', '2001:db8::/32', 'api.example.org']);
    for (const bad of ['http://x.example.com', '10.0.0.0/33', 'a b', '*.', '*foo.example.com', 'x/y']) {
      expect(() => normalizeAllowedUpstreams([bad]), bad).toThrow();
    }
    expect(() => normalizeAllowedUpstreams('*.example.com')).toThrow(/array/);
    expect(normalizeAllowedUpstreams(['*'])).toEqual(['*']);
  });

  it('allows only listed hosts, names and ranges', () => {
    for (const upstream of [
      'app.alpha.example.com:8080', 'http://deep.app.alpha.example.com', 'https://api.example.org:8443',
      '10.1.2.3:80', 'http://[2001:db8::1]:8080', '192.0.2.7:443',
    ]) {
      expect(upstreamRefusal(patterns, upstream), upstream).toBeNull();
    }
    for (const upstream of [
      'alpha.example.com:80', 'evil.example.com:80', '10.2.0.1:80', '192.0.2.8:80', 'localhost:3000',
      'api.example.org.evil.example.com:80', 'http://[2001:db9::1]:80',
    ]) {
      expect(upstreamRefusal(patterns, upstream), upstream).toMatch(/allowed upstreams/);
    }
  });

  it('never allows sockets, placeholders or the admin API port', () => {
    const any = ['*'];
    expect(upstreamRefusal(any, 'unix//run/docker.sock')).toMatch(/Unix socket/);
    expect(upstreamRefusal(any, '{http.request.header.X-Target}:80')).toMatch(/placeholders/);
    expect(upstreamRefusal(any, 'caddy:2019')).toMatch(/2019/);
    expect(upstreamRefusal(any, 'http://localhost:2019/config')).toMatch(/2019/);
    expect(upstreamRefusal(any, 'backend')).toMatch(/host and port/);
    expect(upstreamRefusal(any, 'backend:8080')).toBeNull();
    expect(upstreamRefusal([], 'backend:8080')).toMatch(/allowed upstreams/);
  });
});

function selfSignedPem(names: string[], commonName = names[0]): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2027-01-01T00:00:00Z');
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  if (names.length > 0) cert.setExtensions([{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

describe('domains across organisations', () => {
  it('clash when equal or covered by a wildcard, one label deep', () => {
    expect(namesClash('app.example.com', 'app.example.com')).toBe(true);
    expect(namesClash('app.example.com', '*.example.com')).toBe(true);
    expect(namesClash('*.example.com', 'app.example.com')).toBe(true);
    expect(namesClash('*.example.com', '*.example.com')).toBe(true);
    expect(namesClash('a.b.example.com', '*.example.com')).toBe(false);
    expect(namesClash('example.com', '*.example.com')).toBe(false);
    expect(namesClash('app.example.com', 'app.example.org')).toBe(false);
  });

  it('reads the names Caddy matches from a PEM', () => {
    expect(certificatePemNames(selfSignedPem(['B.example.com', '*.bravo.example.com']))).toEqual(['b.example.com', '*.bravo.example.com']);
    expect(certificatePemNames(selfSignedPem([], 'cn.example.com'))).toEqual(['cn.example.com']);
    expect(certificatePemNames('not a pem')).toEqual([]);
    expect(certificatePemNames(null)).toEqual([]);
  });
});

describe('analytics hosts', () => {
  it('maps stored Host headers to an organisation\'s domains', () => {
    expect(storedHostName('App.Example.com:8443')).toBe('app.example.com');
    expect(storedHostName('[2001:db8::1]:443')).toBe('[2001:db8::1]');
    expect(hostMatchesDomains('APP.example.com:443', ['app.example.com'])).toBe(true);
    expect(hostMatchesDomains('x.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatchesDomains('x.y.example.com', ['*.example.com'])).toBe(false);
    expect(hostMatchesDomains('other.example.com', ['app.example.com'])).toBe(false);
  });
});

describe('usage reports', () => {
  const now = new Date('2026-09-15T12:00:00Z');

  it('parse the period', () => {
    expect(parseUsagePeriod(new URLSearchParams(), now)).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-15T12:00:00.000Z' });
    expect(parseUsagePeriod(new URLSearchParams('month=2026-08'), now)).toEqual({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.000Z' });
    expect(parseUsagePeriod(new URLSearchParams('from=2026-07-01&to=2026-07-02'), now)).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-02T23:59:59.000Z',
    });
    for (const query of ['month=2026-13', 'month=2026-10', 'from=2026-07-02&to=2026-07-01', 'from=yesterday', 'from=2024-01-01&to=2026-01-01']) {
      expect(() => parseUsagePeriod(new URLSearchParams(query), now), query).toThrow();
    }
  });

  it('export CSV with formula-looking text defused', () => {
    const report: UsageReport = {
      period: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-15T12:00:00.000Z' },
      analyticsAvailable: true,
      rows: [{
        organizationId: 1, organizationName: '=HYPERLINK("x")', organizationSlug: 'acme', enabled: true,
        from: '2026-09-01T00:00:00.000Z', to: '2026-09-15T12:00:00.000Z',
        proxyHosts: 2, enabledProxyHosts: 1, users: 3, requests: 10, bytes: 2048, wafBlocks: 1,
      }],
    };
    const lines = usageReportCsv(report).trim().split('\r\n');
    expect(lines[0]).toBe('organizationId,organizationSlug,organizationName,from,to,proxyHosts,enabledProxyHosts,users,requests,bytes,wafBlocks');
    expect(lines[1]).toBe(`1,acme,"'=HYPERLINK(""x"")",2026-09-01T00:00:00.000Z,2026-09-15T12:00:00.000Z,2,1,3,10,2048,1`);
  });
});
