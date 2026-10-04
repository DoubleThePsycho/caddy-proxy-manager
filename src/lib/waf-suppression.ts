/**
 * Per-host WAF rule suppression: excludes a rule for the proxy host that
 * serves a request host. Used by "Suppress for host" on the WAF events page
 * and by applying a WAF tuning suggestion (ee/ai), so both change the
 * configuration the same way: a whole-host exclusion record (see
 * src/lib/models/waf-exclusions.ts), recorded in the audit log and applied to
 * Caddy.
 */
import { listProxyHosts } from "./models/proxy-hosts";
import { createWafExclusion, listWafExclusions } from "./models/waf-exclusions";
import { applyCaddyConfig } from "./caddy";

/** Strips a trailing port from a request Host value ("app.example.com:443" → "app.example.com"). */
export function bareRequestHost(hostname: string): string {
  return hostname.replace(/:\d+$/, "");
}

/** The proxy host whose domains include the request host (port ignored). */
export function findProxyHostForRequestHost<T extends { domains: string[] }>(hosts: readonly T[], hostname: string): T | undefined {
  const bare = bareRequestHost(hostname);
  return hosts.find((host) => host.domains.includes(bare));
}

/** Reason recorded for exclusions added from a WAF event. */
export const SUPPRESSED_FROM_EVENT_REASON = "Suppressed from a WAF event";

/**
 * Excludes `ruleId` for the proxy host serving `hostname`, on every path and
 * variable. Returns the host, or null when no proxy host serves `hostname`.
 * A rule already excluded for the whole host is left as it is.
 */
export async function suppressWafRuleForHost(
  ruleId: number,
  hostname: string,
  actorUserId: number,
  reason = SUPPRESSED_FROM_EVENT_REASON
): Promise<{ id: number; name: string; alreadySuppressed: boolean } | null> {
  const hosts = await listProxyHosts();
  const host = findProxyHostForRequestHost(hosts, hostname);
  if (!host) return null;
  const existing = await listWafExclusions({ proxyHostId: host.id, ruleId });
  if (existing.some((exclusion) => !exclusion.path && !exclusion.variable)) {
    return { id: host.id, name: host.name, alreadySuppressed: true };
  }
  // Stored first, then applied: when Caddy is unreachable the exclusion stays
  // and the error says it was not applied (callers report that, see
  // applyWafTuningSuggestion), as suppression always did.
  await createWafExclusion({ ruleId, proxyHostId: host.id, reason }, actorUserId);
  await applyCaddyConfig();
  return { id: host.id, name: host.name, alreadySuppressed: false };
}
