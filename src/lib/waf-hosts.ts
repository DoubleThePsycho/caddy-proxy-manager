/**
 * The WAF as each proxy host gets it: its mode setting (inherit, off,
 * detection only, block), what the global and host settings add up to, and
 * how the host's settings differ from the global ones. Setting a host's mode
 * goes through updateProxyHost, so it is validated, guarded by change
 * approvals, recorded in the audit log and applied like any host change.
 */
import { getProxyHost, listProxyHosts, updateProxyHost, type ProxyHost } from "./models/proxy-hosts";
import { getWafSettings, type WafSettings } from "./settings";
import { resolveEffectiveWaf } from "./caddy-waf";
import { countWafExclusionsByScope } from "./models/waf-exclusions";
import {
  effectiveModeOfEngine,
  hostModeOf,
  hostSettingsKind,
  hostWafDifferences,
  withHostMode,
  type WafEffectiveMode,
  type WafHostMode,
  type WafHostSettingsKind,
} from "./waf-host-mode";

export type WafHostView = {
  id: number;
  name: string;
  domains: string[];
  /** Whether the proxy host itself is enabled. */
  hostEnabled: boolean;
  /** The host's mode setting. */
  mode: WafHostMode;
  /** True when the host has WAF settings of its own; a host without them inherits and uses the WAF only when it applies to all hosts. */
  configured: boolean;
  /** Merge with or override the global settings. */
  rules: "merge" | "override";
  /** What the host gets. */
  effectiveMode: WafEffectiveMode;
  /** Whether the host's WAF loads the OWASP Core Rule Set (false when the WAF is off). */
  loadOwaspCrs: boolean;
  settings: WafHostSettingsKind;
  /** How the host's settings differ from the global ones, as short phrases. */
  differences: string[];
  /** The host's own rule exclusions. */
  exclusions: number;
};

export function wafHostView(host: ProxyHost, global: WafSettings | null, hostExclusions: number): WafHostView {
  const waf = host.waf ?? null;
  const effective = resolveEffectiveWaf(global, waf);
  const effectiveMode: WafEffectiveMode = effective?.enabled ? effectiveModeOfEngine(effective.mode) : "off";
  const differences = hostWafDifferences(global, waf);
  if (hostExclusions > 0) differences.push(`${hostExclusions} rule ${hostExclusions === 1 ? "exclusion" : "exclusions"}`);
  return {
    id: host.id,
    name: host.name,
    domains: host.domains,
    hostEnabled: host.enabled,
    mode: hostModeOf(waf),
    configured: waf !== null && typeof waf.enabled === "boolean",
    rules: waf?.waf_mode === "override" ? "override" : "merge",
    effectiveMode,
    loadOwaspCrs: effectiveMode !== "off" && Boolean(effective?.load_owasp_crs),
    settings: hostSettingsKind(global, waf, hostExclusions),
    differences,
    exclusions: hostExclusions,
  };
}

export async function listWafHostViews(): Promise<WafHostView[]> {
  const [hosts, global, counts] = await Promise.all([listProxyHosts(), getWafSettings(), countWafExclusionsByScope()]);
  return hosts
    .map((host) => wafHostView(host, global, counts.get(host.id) ?? 0))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getWafHostView(id: number): Promise<WafHostView | null> {
  const [host, global, counts] = await Promise.all([getProxyHost(id), getWafSettings(), countWafExclusionsByScope()]);
  return host ? wafHostView(host, global, counts.get(host.id) ?? 0) : null;
}

/**
 * Sets a host's WAF mode, keeping the rest of its WAF settings. Throws
 * "Proxy host not found" (404) for an unknown host.
 */
export async function setWafHostMode(id: number, mode: WafHostMode, actorUserId: number): Promise<WafHostView> {
  const host = await getProxyHost(id);
  if (!host) throw new Error("Proxy host not found");
  await updateProxyHost(id, { waf: withHostMode(host.waf, mode) }, actorUserId);
  return (await getWafHostView(id))!;
}
