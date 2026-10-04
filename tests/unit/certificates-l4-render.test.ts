/**
 * Server-side render of the redesigned certificates and L4 hosts pages:
 * the three certificate tabs, the expiry timeline, the certificate table's
 * columns and states, and the L4 table with its detail panel. No invented
 * traffic metrics on the L4 page.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/l4-proxy-hosts',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(dashboard)/certificates/actions', () => ({
  createCertificateAction: vi.fn(),
  updateCertificateAction: vi.fn(),
  deleteCertificateAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/certificates/ca-actions', () => ({
  createCaCertificateAction: vi.fn(),
  updateCaCertificateAction: vi.fn(),
  deleteCaCertificateAction: vi.fn(),
  generateCaCertificateAction: vi.fn(),
  issueClientCertificateAction: vi.fn(),
  revokeIssuedClientCertificateAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/l4-proxy-hosts/actions', () => ({
  createL4ProxyHostAction: vi.fn(),
  updateL4ProxyHostAction: vi.fn(),
  deleteL4ProxyHostAction: vi.fn(),
  toggleL4ProxyHostAction: vi.fn(),
}));

import CertificatesClient from '@/app/(dashboard)/certificates/CertificatesClient';
import type { CaCertificateView, IssuedClientCertificateView, MtlsRoleView } from '@/app/(dashboard)/certificates/page';
import L4ProxyHostsClient from '@/app/(dashboard)/l4-proxy-hosts/L4ProxyHostsClient';
import type { CertificateOverviewRow } from '@/src/lib/certificate-renewal';
import type { L4ProxyHost } from '@/src/lib/models/l4-proxy-hosts';

const NOW = '2026-10-03T12:00:00.000Z';
const day = (offset: number) => new Date(Date.parse(NOW) + offset * 86_400_000).toISOString();

const rows: CertificateOverviewRow[] = [
  {
    id: 'acme:1',
    kind: 'acme',
    certificateId: null,
    hostId: 1,
    name: 'Auth',
    domains: ['auth.example.com'],
    active: true,
    issuer: "Let's Encrypt",
    issuerFromCertificate: true,
    keyType: 'ECDSA P-256',
    validFrom: day(-59),
    validTo: day(31),
    expirySource: 'caddy',
    daysLeft: 31,
    obtainedBy: { method: 'acme', challenge: 'http-01', dnsProvider: null, directory: null },
    renewal: { state: 'scheduled', renewFrom: day(1) },
    usedBy: [
      { kind: 'proxy_host', id: 1, name: 'Auth', domains: ['auth.example.com'] },
      { kind: 'l4_host', id: 9, name: 'DNS over TLS', domains: ['auth.example.com'] },
    ],
  },
  {
    id: 'certificate:4',
    kind: 'imported',
    certificateId: 4,
    hostId: null,
    name: 'Files wildcard',
    domains: ['files.example.com', '*.files.example.com'],
    active: true,
    issuer: 'Example CA',
    issuerFromCertificate: true,
    keyType: 'RSA 2048',
    validFrom: day(-300),
    validTo: day(20),
    expirySource: 'pem',
    daysLeft: 20,
    obtainedBy: { method: 'imported' },
    renewal: { state: 'replace_soon', renewFrom: null },
    usedBy: [],
  },
  {
    id: 'acme:2',
    kind: 'acme',
    certificateId: null,
    hostId: 2,
    name: 'Grafana',
    domains: ['grafana.example.com'],
    active: true,
    issuer: "Let's Encrypt",
    issuerFromCertificate: false,
    keyType: null,
    validFrom: null,
    validTo: null,
    expirySource: null,
    daysLeft: null,
    obtainedBy: { method: 'acme', challenge: 'dns-01', dnsProvider: 'Cloudflare', directory: null },
    renewal: { state: 'unknown', renewFrom: null },
    usedBy: [{ kind: 'proxy_host', id: 2, name: 'Grafana', domains: ['grafana.example.com'] }],
  },
];

const ca: CaCertificateView = {
  id: 1,
  name: 'Staff client CA',
  certificatePem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
  hasPrivateKey: true,
  createdAt: '2026-03-02T00:00:00.000Z',
  updatedAt: '2026-03-02T00:00:00.000Z',
  issuedCerts: [],
  validTo: '2036-03-02T00:00:00.000Z',
  trustedBy: [{ id: 3, name: 'Registry', domain: 'registry.example.com' }],
};
const clientCert: IssuedClientCertificateView = {
  id: 7,
  caCertificateId: 1,
  commonName: 'ci-runner',
  serialNumber: 'AB',
  fingerprintSha256: 'aa',
  certificatePem: 'pem',
  validFrom: '2026-03-12T00:00:00.000Z',
  validTo: '2027-03-12T00:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-03-12T00:00:00.000Z',
  updatedAt: '2026-03-12T00:00:00.000Z',
  caName: 'Staff client CA',
  roles: ['automation'],
};
const role: MtlsRoleView = {
  id: 5,
  name: 'automation',
  description: 'CI runners',
  certificateCount: 1,
  createdAt: '2026-03-12T00:00:00.000Z',
  updatedAt: '2026-03-12T00:00:00.000Z',
  certificateIds: [7],
  requiredBy: [{ id: 3, name: 'Registry', domain: 'registry.example.com' }],
};

function renderCertificates(initialTab: 'certificates' | 'authorities' | 'client', showTrustAnchors = true) {
  return renderToStaticMarkup(
    createElement(CertificatesClient, {
      overview: { generatedAt: NOW, certificates: rows },
      caCertificates: [{ ...ca, issuedCerts: [clientCert] }],
      clientCertificates: [clientCert],
      mtlsRoles: [role],
      showTrustAnchors,
      canWrite: true,
      canCreateCertificate: true,
      canReadSettings: true,
      acmeEmail: 'admin@example.com',
      initialTab,
    })
  );
}

describe('certificates page', () => {
  it('renders the three tabs, the timeline and the certificate table', () => {
    const html = renderCertificates('certificates');
    expect(html).toContain('Certificates</h1>');
    for (const tab of ['Certificate authorities', 'Client certificates']) expect(html).toContain(tab);
    expect(html).toContain('Expiry, next 90 days');
    expect(html).toContain('aria-label="auth.example.com: 31 days left');
    expect(html).toContain('href="/settings?section=dns-providers"');
    expect(html).toContain('Import certificate');
    for (const column of ['Domains', 'Issuer', 'Obtained by', 'Expires', 'Renewal', 'Used by']) expect(html).toContain(`>${column}</th>`);
    // ACME: served certificate, renewal date; imported: replace soon; unread: not read yet.
    expect(html).toContain('From 4 Oct');
    expect(html).toContain('Replace soon');
    expect(html).toContain('Not read yet');
    expect(html).toContain('Cloudflare');
    // Used by: a proxy host and an L4 host.
    expect(html).toContain('1 proxy host, and DNS over TLS (L4)');
    expect(html).toContain('admin@example.com');
    expect(html).toContain('1 not shown: their expiry is not read yet.');
  });

  it('renders the certificate authorities tab', () => {
    const html = renderCertificates('authorities');
    expect(html).toContain('Certificate authorities for client certificates');
    expect(html).toContain('Stored, encrypted');
    expect(html).toContain('2 Mar 2036');
    expect(html).toContain('More actions for Staff client CA');
    expect(html).toContain('Add certificate authority');
  });

  it('renders roles and client certificates together', () => {
    const html = renderCertificates('client');
    expect(html).toContain('CI runners. <span class="num">1</span> certificate');
    expect(html).toContain('required by registry.example.com');
    expect(html).toContain('ci-runner');
    expect(html).toContain('aria-label="Revoke ci-runner"');
    expect(html).toContain('Issue client certificate');
  });

  it('shows only the certificate list without trust anchors', () => {
    const html = renderCertificates('certificates', false);
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('Certificate authorities');
  });
});

describe('L4 hosts page', () => {
  const base: L4ProxyHost = {
    id: 1,
    name: 'DNS over TLS',
    protocol: 'tcp',
    listenAddress: ':853',
    upstreams: ['adguard:53'],
    matcherType: 'tls_sni',
    matcherValue: ['dns.example.com'],
    tlsTermination: true,
    proxyProtocolVersion: null,
    proxyProtocolReceive: false,
    enabled: true,
    meta: null,
    loadBalancer: null,
    dnsResolver: null,
    upstreamDnsResolution: null,
    geoblock: null,
    geoblockMode: 'merge',
    tags: ['network'],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const hosts: L4ProxyHost[] = [
    base,
    { ...base, id: 2, name: 'WireGuard', protocol: 'udp', listenAddress: ':51820', upstreams: ['wireguard:51820'], matcherType: 'none', matcherValue: [], tlsTermination: false, tags: [] },
    { ...base, id: 3, name: 'Mail', listenAddress: ':993', upstreams: ['dovecot:10993'], matcherType: 'none', matcherValue: [], tlsTermination: false, proxyProtocolVersion: 'v2', enabled: false, tags: [] },
  ];

  function render(list: L4ProxyHost[], totalHosts = list.length) {
    return renderToStaticMarkup(
      createElement(L4ProxyHostsClient, {
        hosts: list,
        totalHosts,
        pagination: { total: list.length, page: 1, perPage: 25 },
        initialSearch: '',
        protocol: 'all',
        protocolCounts: { all: 3, tcp: 2, udp: 1 },
        canWrite: true,
      })
    );
  }

  it('renders filters, the table and the selected host', () => {
    const html = render(hosts);
    expect(html).toContain('L4 hosts');
    expect(html).toContain('New L4 host');
    expect(html).toContain('aria-label="Protocol"');
    expect(html).toContain('placeholder="Name, port or upstream"');
    for (const column of ['Name', 'Listen', 'Upstream', 'TLS', 'PROXY protocol', 'Status']) expect(html).toContain(column);
    expect(html).toContain('Terminate');
    expect(html).toContain('Sends v2');
    expect(html).toContain('Disabled');
    // The first host is selected and detailed.
    expect(html).toContain(':853/tcp');
    expect(html).toContain('On, certificate for dns.example.com');
    expect(html).toContain('More actions for WireGuard');
    expect(html).not.toMatch(/Open now|Transferred|Open connections/);
  });

  it('shows an empty state with one action when there are no L4 hosts', () => {
    const html = render([], 0);
    expect(html).toContain('No L4 hosts yet');
    expect(html).not.toContain('<table');
  });
});
