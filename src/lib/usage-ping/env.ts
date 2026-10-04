/**
 * The usage ping's environment switches:
 *
 * - USAGE_PING_DISABLED turns it off entirely: nothing is ever sent, the
 *   overview question is hidden and the setting cannot be turned on. Any
 *   value other than empty, "false", "0", "no" or "off" counts as set, so a
 *   typo errs on the side of not sending.
 * - USAGE_PING_ENABLED answers the overview question with yes at start-up,
 *   for installs nobody signs in to. Only "true", "1", "yes" or "on" count,
 *   so a typo errs on the side of not sending. It never overrides an answer
 *   already given, and USAGE_PING_DISABLED wins over it.
 * - USAGE_PING_URL replaces the endpoint. It must be an https URL without
 *   credentials; an invalid value means nothing is sent (it never falls back
 *   to the default endpoint).
 */

export const DEFAULT_USAGE_PING_URL = "https://ping.ingres.si/v1/ping";

const OFF_VALUES = new Set(["", "false", "0", "no", "off"]);
const ON_VALUES = new Set(["true", "1", "yes", "on"]);

type Env = Record<string, string | undefined>;

export function isUsagePingDisabledByEnv(env: Env = process.env): boolean {
  const value = env.USAGE_PING_DISABLED;
  if (value === undefined) return false;
  return !OFF_VALUES.has(value.trim().toLowerCase());
}

export function isUsagePingEnabledByEnv(env: Env = process.env): boolean {
  const value = env.USAGE_PING_ENABLED;
  return value !== undefined && ON_VALUES.has(value.trim().toLowerCase());
}

export type UsagePingEndpoint = { url: string; error: null } | { url: null; error: string };

export function resolveUsagePingEndpoint(env: Env = process.env): UsagePingEndpoint {
  const raw = env.USAGE_PING_URL?.trim();
  if (!raw) return { url: DEFAULT_USAGE_PING_URL, error: null };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: null, error: "USAGE_PING_URL is not a valid URL" };
  }
  if (parsed.protocol !== "https:") return { url: null, error: "USAGE_PING_URL must be an https:// URL" };
  if (parsed.username || parsed.password) return { url: null, error: "USAGE_PING_URL must not contain credentials" };
  return { url: parsed.toString(), error: null };
}
