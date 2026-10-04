/**
 * The L4 hosts page's filtering, sorting and descriptions
 * (app/(dashboard)/l4-proxy-hosts/list.ts) and the port helpers of the
 * pending-ports banner.
 */
import { describe, expect, it } from 'vitest';
import type { L4ProxyHost } from '@/src/lib/models/l4-proxy-hosts';
import {
  l4DetailGroups,
  matchesL4Search,
  matcherText,
  proxyProtocolText,
  sortL4Hosts,
  tlsView,
} from '@/app/(dashboard)/l4-proxy-hosts/list';
import { portLabel, portMappingFor } from '@/src/components/l4-proxy-hosts/L4PortsApplyBanner';

function host(overrides: Partial<L4ProxyHost>): L4ProxyHost {
  return {
    id: 1,
    name: 'Git over SSH',
    protocol: 'tcp',
    listenAddress: ':2222',
    upstreams: ['forgejo:22'],
    matcherType: 'none',
    matcherValue: [],
    tlsTermination: false,
    proxyProtocolVersion: null,
    proxyProtocolReceive: false,
    enabled: true,
    meta: null,
    loadBalancer: null,
    dnsResolver: null,
    upstreamDnsResolution: null,
    geoblock: null,
    geoblockMode: 'merge',
    tags: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('L4 hosts list', () => {
  it('searches name, port, upstreams, server names and tags', () => {
    const h = host({ matcherType: 'tls_sni', matcherValue: ['git.example.com'], tags: ['dev'] });
    for (const q of ['git over', '2222', 'FORGEJO', 'git.example.com', 'dev']) expect(matchesL4Search(h, q)).toBe(true);
    expect(matchesL4Search(h, 'wireguard')).toBe(false);
  });

  it('sorts listen addresses by port number', () => {
    const hosts = [host({ id: 1, listenAddress: ':2222' }), host({ id: 2, listenAddress: ':853' }), host({ id: 3, listenAddress: ':25' })];
    expect(sortL4Hosts(hosts, 'listenAddress', 'asc').map((h) => h.listenAddress)).toEqual([':25', ':853', ':2222']);
    expect(sortL4Hosts(hosts, 'listenAddress', 'desc').map((h) => h.id)).toEqual([1, 2, 3]);
  });

  it('describes TLS and the PROXY protocol', () => {
    expect(tlsView(host({ tlsTermination: true, matcherType: 'tls_sni', matcherValue: ['dns.example.com'] }))).toEqual({
      label: 'Terminate',
      detail: 'dns.example.com',
      muted: false,
    });
    expect(tlsView(host({ matcherType: 'tls_sni', matcherValue: ['mail.example.com'] })).label).toBe('Passthrough');
    expect(tlsView(host({})).label).toBe('Not terminated');
    expect(tlsView(host({ protocol: 'udp' })).label).toBe('Not TLS');
    expect(proxyProtocolText(host({ proxyProtocolVersion: 'v2' }))).toBe('Sends v2');
    expect(proxyProtocolText(host({ proxyProtocolReceive: true, proxyProtocolVersion: 'v1' }))).toBe('Accepts, sends v1');
    expect(proxyProtocolText(host({}))).toBe('Off');
    expect(matcherText(host({ protocol: 'udp' }))).toBe('None, every datagram');
  });

  it('builds the detail panel from the host settings only', () => {
    const groups = l4DetailGroups(
      host({
        upstreams: ['a:22', 'b:22'],
        loadBalancer: {
          enabled: true,
          policy: 'round_robin',
          tryDuration: null,
          tryInterval: null,
          activeHealthCheck: { enabled: true, port: 22, interval: '30s', timeout: null },
          passiveHealthCheck: null,
        },
        geoblock: {
          enabled: true,
          block_countries: [],
          block_continents: [],
          block_asns: [],
          block_cidrs: [],
          block_ips: [],
          allow_countries: [],
          allow_continents: [],
          allow_asns: [],
          allow_cidrs: ['203.0.113.0/26'],
          allow_ips: [],
        },
        geoblockMode: 'override',
        upstreamDnsResolution: { enabled: true, family: 'ipv4' },
      })
    );
    const values = Object.fromEntries(groups.flatMap((g) => g.items.map((item) => [item.label, item.value])));
    expect(values).toMatchObject({
      Protocol: 'TCP',
      Upstreams: 'a:22, b:22',
      'Load balancing': 'Round robin',
      'Health check': 'Connect to port 22 every 30s',
      'TLS termination': 'Off',
      'Geo blocking': 'Own rules only: allow 203.0.113.0/26',
      'Upstream DNS pinning': 'On, IPv4',
      'DNS resolver': 'Global resolvers',
      Tags: 'None',
    });
    // No traffic figures: the product has no source for L4 connection or byte counts.
    expect(JSON.stringify(groups)).not.toMatch(/connections now|transferred|bytes/i);
  });
});

describe('L4 port helpers', () => {
  it('maps a host to its published port and labels it', () => {
    expect(portMappingFor({ listenAddress: ':8883', protocol: 'tcp' })).toBe('8883:8883');
    expect(portMappingFor({ listenAddress: '0.0.0.0:51820', protocol: 'udp' })).toBe('51820:51820/udp');
    expect(portMappingFor({ listenAddress: 'bad', protocol: 'tcp' })).toBeNull();
    expect(portLabel('8883:8883')).toBe('8883/tcp');
    expect(portLabel('51820:51820/udp')).toBe('51820/udp');
  });
});
