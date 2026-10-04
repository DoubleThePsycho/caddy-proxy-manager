// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: which upstreams an organisation's own users may proxy to.
 *
 * Caddy can reach every network the provider runs it in, including other
 * tenants' backends and internal services. Without a limit, an organisation
 * user could publish another tenant's backend under their own domain and skip
 * the other tenant's authentication. Each organisation therefore has a list of
 * allowed upstreams that the provider sets:
 *
 *   - "app.example.com"   that host name;
 *   - "*.example.com"     any name under example.com (any depth);
 *   - "10.20.0.0/16"      an IPv4 or IPv6 CIDR; "10.20.0.5" one address;
 *   - "*"                 any network upstream (the provider accepts the risk).
 *
 * An empty list allows nothing, so a new organisation cannot proxy anywhere
 * until the provider decides where. Host names are matched as written: the
 * provider vouches for what they resolve to. Unix sockets, Caddy placeholders
 * and Caddy's admin API port (2019) are never allowed to organisation users.
 * Provider-level users are not limited by these lists, including when they
 * edit an organisation's host.
 */
import { BlockList, isIP } from "node:net";
import { parseUpstreamTarget } from "@/src/lib/caddy-utils";
import { ApiValidationError } from "@/src/lib/api-errors";
import { TenantError } from "./scope";

export const MAX_ALLOWED_UPSTREAMS = 64;
const CADDY_ADMIN_PORT = "2019";
const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function splitCidr(pattern: string): { address: string; prefix: number | null } | null {
  const [address, prefixText, extra] = pattern.split("/");
  if (extra !== undefined) return null;
  const family = isIP(address);
  if (family === 0) return null;
  if (prefixText === undefined) return { address, prefix: null };
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > (family === 4 ? 32 : 128)) return null;
  return { address, prefix };
}

/** Validates and normalises an allowed-upstreams list (organisation create/update). */
export function normalizeAllowedUpstreams(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) throw new ApiValidationError("allowedUpstreams must be an array of strings");
  const result = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") throw new ApiValidationError("allowedUpstreams must be an array of strings");
    const pattern = item.trim().toLowerCase();
    if (!pattern) continue;
    const valid =
      pattern === "*" ||
      splitCidr(pattern) !== null ||
      HOST_NAME.test(pattern) ||
      (pattern.startsWith("*.") && HOST_NAME.test(pattern.slice(2)));
    if (!valid) {
      throw new ApiValidationError(
        `"${item.slice(0, 80)}" is not a host name, a *.wildcard, an IP address or CIDR, or "*"`
      );
    }
    result.add(pattern);
  }
  if (result.size > MAX_ALLOWED_UPSTREAMS) {
    throw new ApiValidationError(`An organisation can have at most ${MAX_ALLOWED_UPSTREAMS} allowed upstreams`);
  }
  return [...result].sort();
}

function hostAllowed(patterns: readonly string[], rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  const family = isIP(host);
  if (family === 0 && !HOST_NAME.test(host)) return false;
  for (const pattern of patterns) {
    if (pattern === "*") return true;
    const cidr = splitCidr(pattern);
    if (cidr) {
      if (family === 0) continue;
      const cidrFamily = isIP(cidr.address) === 4 ? "ipv4" : "ipv6";
      const list = new BlockList();
      if (cidr.prefix === null) list.addAddress(cidr.address, cidrFamily);
      else list.addSubnet(cidr.address, cidr.prefix, cidrFamily);
      if (list.check(host, family === 4 ? "ipv4" : "ipv6")) return true;
      continue;
    }
    if (family !== 0) continue;
    if (pattern.startsWith("*.")) {
      if (host.endsWith(pattern.slice(1))) return true;
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Why `upstream` is not allowed for an organisation with `patterns`, or null
 * when it is.
 */
export function upstreamRefusal(patterns: readonly string[], upstream: string): string | null {
  const text = String(upstream ?? "").trim();
  if (!text) return null;
  if (/[{}\s]/.test(text)) return `Upstream "${text.slice(0, 80)}" may not contain placeholders or spaces`;
  if (/^unix\//i.test(text) || text.includes("unix/")) return "Unix socket upstreams are not available to organisations";
  const target = parseUpstreamTarget(text);
  if (!target.host) return `Upstream "${text.slice(0, 80)}" is not a host and port or an http(s) URL`;
  if (target.port === CADDY_ADMIN_PORT) return `Port ${CADDY_ADMIN_PORT} (Caddy's admin API) is not available to organisations`;
  if (!hostAllowed(patterns, target.host)) {
    return `Upstream ${target.host} is not in your organisation's allowed upstreams; ask your provider to allow it`;
  }
  return null;
}

/**
 * Refuses (403) an upstream an organisation user may not use. `kept` are
 * upstreams the row already has (set by the provider): keeping them is fine.
 */
export function assertUpstreamsAllowed(
  patterns: readonly string[],
  upstreams: readonly (string | null | undefined)[],
  kept: readonly (string | null | undefined)[] = []
): void {
  const existing = new Set(kept.filter((value): value is string => typeof value === "string").map((value) => value.trim()));
  for (const upstream of upstreams) {
    if (typeof upstream !== "string" || existing.has(upstream.trim())) continue;
    const refusal = upstreamRefusal(patterns, upstream);
    if (refusal) throw new TenantError(refusal);
  }
}
