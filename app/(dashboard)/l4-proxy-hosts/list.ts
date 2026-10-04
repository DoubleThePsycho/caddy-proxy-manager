/**
 * Filtering, sorting and the plain-language descriptions of the L4 hosts
 * page. Pure functions, shared by the server page and its client.
 */
import type { L4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";

export type L4ProtocolFilter = "all" | "tcp" | "udp";

export const L4_SORT_KEYS = ["name", "protocol", "listenAddress", "upstreams", "enabled", "createdAt"] as const;
export type L4SortKey = (typeof L4_SORT_KEYS)[number];

export function isL4SortKey(value: string | undefined): value is L4SortKey {
  return (L4_SORT_KEYS as readonly string[]).includes(value ?? "");
}

/** Matches name, listen address, upstreams, matcher names and tags, case-insensitively. */
export function matchesL4Search(host: L4ProxyHost, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [host.name, host.listenAddress, ...host.upstreams, ...host.matcherValue, ...host.tags].some((value) =>
    value.toLowerCase().includes(q)
  );
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function sortL4Hosts(hosts: readonly L4ProxyHost[], sortBy: L4SortKey, sortDir: "asc" | "desc"): L4ProxyHost[] {
  const value = (host: L4ProxyHost): string => {
    switch (sortBy) {
      case "name":
        return host.name;
      case "protocol":
        return host.protocol;
      case "listenAddress":
        return host.listenAddress;
      case "upstreams":
        return host.upstreams.join(",");
      case "enabled":
        return host.enabled ? "1" : "0";
      case "createdAt":
      default:
        return host.createdAt;
    }
  };
  const sign = sortDir === "asc" ? 1 : -1;
  return [...hosts].sort((a, b) => sign * collator.compare(value(a), value(b)) || a.id - b.id);
}

export type L4DetailItem = { label: string; value: string; mono?: boolean };
export type L4DetailGroup = { title: string; items: L4DetailItem[] };

const POLICY_LABELS: Record<string, string> = {
  random: "Random",
  round_robin: "Round robin",
  least_conn: "Fewest connections",
  ip_hash: "Client IP hash",
  first: "First available",
};

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "TLS SNI: dns.example.com", "None, every connection". */
export function matcherText(host: L4ProxyHost): string {
  switch (host.matcherType) {
    case "tls_sni":
      return `TLS SNI: ${host.matcherValue.join(", ")}`;
    case "http_host":
      return `HTTP Host: ${host.matcherValue.join(", ")}`;
    case "proxy_protocol":
      return "PROXY protocol header";
    default:
      return host.protocol === "udp" ? "None, every datagram" : "None, every connection";
  }
}

/** The TLS column: what Caddy does with TLS on this host. */
export function tlsView(host: L4ProxyHost): { label: string; detail: string | null; muted: boolean } {
  if (host.protocol === "udp") return { label: "Not TLS", detail: null, muted: true };
  if (host.tlsTermination) {
    return {
      label: "Terminate",
      detail: host.matcherType === "tls_sni" && host.matcherValue.length > 0 ? host.matcherValue.join(", ") : "Any server name",
      muted: false,
    };
  }
  if (host.matcherType === "tls_sni") return { label: "Passthrough", detail: "TLS ends upstream", muted: false };
  return { label: "Not terminated", detail: null, muted: true };
}

/** The PROXY protocol column. */
export function proxyProtocolText(host: L4ProxyHost): string {
  const parts: string[] = [];
  if (host.proxyProtocolReceive) parts.push("Accepts");
  if (host.proxyProtocolVersion) parts.push(parts.length ? `sends ${host.proxyProtocolVersion}` : `Sends ${host.proxyProtocolVersion}`);
  return parts.length ? parts.join(", ") : "Off";
}

function geoSummary(host: L4ProxyHost): string {
  const geo = host.geoblock;
  if (!geo?.enabled) {
    return geo && host.geoblockMode === "override" ? "Off for this host, global rules ignored" : "Global rules only";
  }
  const describe = (verb: string, entries: Array<[readonly (string | number)[], string, string]>) => {
    const values = entries.flatMap(([list]) => list.map(String));
    if (values.length === 0) return null;
    if (values.length <= 3) return `${verb} ${values.join(", ")}`;
    const counts = entries
      .filter(([list]) => list.length > 0)
      .map(([list, one, many]) => `${list.length} ${list.length === 1 ? one : many}`);
    return `${verb} ${joinList(counts)}`;
  };
  const block = describe("block", [
    [geo.block_countries, "country", "countries"],
    [geo.block_continents, "continent", "continents"],
    [geo.block_asns, "ASN", "ASNs"],
    [geo.block_cidrs, "range", "ranges"],
    [geo.block_ips, "address", "addresses"],
  ]);
  const allow = describe("allow", [
    [geo.allow_countries, "country", "countries"],
    [geo.allow_continents, "continent", "continents"],
    [geo.allow_asns, "ASN", "ASNs"],
    [geo.allow_cidrs, "range", "ranges"],
    [geo.allow_ips, "address", "addresses"],
  ]);
  const rules = [allow, block].filter(Boolean).join("; ") || "no rules yet";
  return host.geoblockMode === "override" ? `Own rules only: ${rules}` : `Own rules added to the global ones: ${rules}`;
}

function healthText(host: L4ProxyHost): string {
  const lb = host.loadBalancer;
  const parts: string[] = [];
  if (lb?.enabled && lb.activeHealthCheck?.enabled) {
    const port = lb.activeHealthCheck.port ? `port ${lb.activeHealthCheck.port}` : "the upstream port";
    parts.push(`Connect to ${port} every ${lb.activeHealthCheck.interval ?? "30s"}`);
  }
  if (lb?.enabled && lb.passiveHealthCheck?.enabled) {
    const fails = lb.passiveHealthCheck.maxFails ?? 1;
    parts.push(
      `skip an upstream after ${fails} failed ${fails === 1 ? "connection" : "connections"}${
        lb.passiveHealthCheck.failDuration ? ` for ${lb.passiveHealthCheck.failDuration}` : ""
      }`
    );
  }
  if (parts.length === 0) return "Off";
  const text = parts.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function loadBalancingText(host: L4ProxyHost): string {
  const lb = host.loadBalancer;
  if (lb?.enabled) {
    const policy = POLICY_LABELS[lb.policy] ?? lb.policy;
    return lb.tryDuration ? `${policy}, keeps trying for ${lb.tryDuration}` : policy;
  }
  return host.upstreams.length > 1 ? "Off, Caddy picks an upstream at random" : "Off, one upstream";
}

function dnsPinningText(host: L4ProxyHost): string {
  const pinning = host.upstreamDnsResolution;
  if (!pinning || pinning.enabled === null) return "Inherit global";
  if (!pinning.enabled) return "Off";
  const family = pinning.family === "ipv4" ? "IPv4" : pinning.family === "ipv6" ? "IPv6" : "IPv4 and IPv6";
  return `On, ${family}`;
}

function resolverText(host: L4ProxyHost): string {
  const resolver = host.dnsResolver;
  if (!resolver?.enabled || resolver.resolvers.length === 0) return "Global resolvers";
  return resolver.resolvers.join(", ");
}

/** The detail panel's groups, from the host's own settings. */
export function l4DetailGroups(host: L4ProxyHost): L4DetailGroup[] {
  const tls =
    host.protocol === "udp"
      ? "Not available for UDP"
      : host.tlsTermination
        ? host.matcherType === "tls_sni" && host.matcherValue.length > 0
          ? `On, certificate for ${host.matcherValue.join(", ")}`
          : "On, certificate for the client's server name"
        : "Off";
  return [
    {
      title: "Listening",
      items: [
        { label: "Protocol", value: host.protocol.toUpperCase() },
        { label: "Listen address", value: host.listenAddress, mono: true },
        { label: "Matcher", value: matcherText(host) },
      ],
    },
    {
      title: "Upstream",
      items: [
        { label: host.upstreams.length === 1 ? "Upstream" : "Upstreams", value: host.upstreams.join(", "), mono: true },
        { label: "Load balancing", value: loadBalancingText(host) },
        { label: "Health check", value: healthText(host) },
      ],
    },
    {
      title: "TLS and PROXY protocol",
      items: [
        { label: "TLS termination", value: tls },
        { label: "Accept inbound PROXY protocol", value: host.proxyProtocolReceive ? "On" : "Off" },
        { label: "Send PROXY protocol to upstream", value: host.proxyProtocolVersion ?? "None" },
      ],
    },
    {
      title: "Access and DNS",
      items: [
        { label: "Geo blocking", value: geoSummary(host) },
        { label: "Upstream DNS pinning", value: dnsPinningText(host) },
        { label: "DNS resolver", value: resolverText(host) },
        { label: "Tags", value: host.tags.length ? host.tags.join(", ") : "None" },
      ],
    },
  ];
}
