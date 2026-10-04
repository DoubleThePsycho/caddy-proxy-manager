/**
 * The WAF mode of one proxy host: inherit the global mode, off, detection only
 * or block. Stored in the host's meta.waf as it always was (`enabled` plus
 * Coraza's engine value in `mode`), so older stored values read the same way:
 * a host without WAF settings or without a mode inherits, `enabled: false` or
 * `mode: "Off"` is off, `mode: "On"` blocks, and the new
 * `mode: "DetectionOnly"` logs without blocking.
 */
import type { WafHostConfig } from "./models/proxy-hosts";
import type { WafSettings } from "./settings";

export const WAF_HOST_MODES = ["inherit", "off", "detection_only", "block"] as const;
export type WafHostMode = (typeof WAF_HOST_MODES)[number];

/** What a host gets once the global and host settings are combined. */
export type WafEffectiveMode = "off" | "detection_only" | "block";

export function isWafHostMode(value: unknown): value is WafHostMode {
  return (WAF_HOST_MODES as readonly unknown[]).includes(value);
}

/** A Coraza engine value as an effective mode; anything unknown blocks, as buildWafHandler does. */
export function effectiveModeOfEngine(mode: string | null | undefined): WafEffectiveMode {
  if (mode === "Off") return "off";
  if (mode === "DetectionOnly") return "detection_only";
  return "block";
}

/** The host's mode setting as stored in meta.waf. */
export function hostModeOf(waf: WafHostConfig | null | undefined): WafHostMode {
  if (!waf) return "inherit";
  if (waf.enabled === false) return "off";
  if (waf.mode === "Off") return "off";
  if (waf.mode === "DetectionOnly") return "detection_only";
  if (waf.mode === "On") return "block";
  return "inherit";
}

/**
 * The host's WAF settings with `mode` set. Everything else the host has (its
 * rules, body limits, merge or override) is kept, so switching the WAF off
 * and on again restores it. "inherit" turns the host's WAF section on with
 * the global mode: the host uses the WAF even when the global WAF does not
 * apply to every host.
 */
export function withHostMode(waf: WafHostConfig | null | undefined, mode: WafHostMode): WafHostConfig {
  const { mode: _previousMode, ...rest } = waf ?? {};
  void _previousMode;
  const base: WafHostConfig = { ...rest, waf_mode: waf?.waf_mode ?? "merge" };
  switch (mode) {
    case "off":
      return { ...base, ...(waf?.mode ? { mode: waf.mode } : {}), enabled: false };
    case "detection_only":
      return { ...base, enabled: true, mode: "DetectionOnly" };
    case "block":
      return { ...base, enabled: true, mode: "On" };
    case "inherit":
      return { ...base, enabled: true };
  }
}

/** How the host's settings relate to the global ones, for display. */
export type WafHostSettingsKind = "follows" | "merges" | "overrides" | "off";

/**
 * What the host changes compared with the global settings, as short
 * phrases (rule exclusions are counted by the caller).
 */
export function hostWafDifferences(
  global: Pick<WafSettings, "load_owasp_crs"> | null | undefined,
  waf: WafHostConfig | null | undefined
): string[] {
  if (!waf || waf.enabled === false) return [];
  const differences: string[] = [];
  if (waf.mode === "DetectionOnly") differences.push("detection only");
  else if (waf.mode === "On") differences.push("blocking");
  const globalCrs = Boolean(global?.load_owasp_crs);
  if (waf.load_owasp_crs !== undefined && (waf.waf_mode === "override" || waf.load_owasp_crs !== globalCrs)) {
    differences.push(waf.load_owasp_crs ? "Core Rule Set on" : "Core Rule Set off");
  }
  if (waf.custom_directives?.trim()) differences.push("custom rules");
  if (waf.request_body_limit !== undefined || waf.request_body_in_memory_limit !== undefined) differences.push("body limits");
  if (waf.request_body_limit_action === "ProcessPartial") differences.push("inspects the start of large bodies");
  else if (waf.request_body_limit_action === "Reject") differences.push("rejects large bodies");
  return differences;
}

export function hostSettingsKind(
  global: Pick<WafSettings, "load_owasp_crs"> | null | undefined,
  waf: WafHostConfig | null | undefined,
  hostExclusions = 0
): WafHostSettingsKind {
  if (waf?.enabled === false || (waf?.enabled && waf.mode === "Off")) return "off";
  if (waf?.enabled && waf.waf_mode === "override") return "overrides";
  if (hostExclusions > 0 || hostWafDifferences(global, waf).length > 0) return "merges";
  return "follows";
}

/** Global settings that apply to no host have no mode to inherit. */
export function globalEffectiveMode(global: Pick<WafSettings, "mode"> | null | undefined): WafEffectiveMode {
  return global ? effectiveModeOfEngine(global.mode) : "block";
}
