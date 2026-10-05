/**
 * WAF rule exclusions: validation of their fields and the Coraza directives
 * they become. Free of database access, so the Caddy config builder, the API
 * and tests share it; the records live in src/lib/models/waf-exclusions.ts.
 *
 * An exclusion skips one rule. With neither a path nor a variable it removes
 * the rule from the scope's WAF handler (SecRuleRemoveById, as the legacy
 * excluded_rule_ids lists always did). A path and/or a variable narrow it to
 * matching requests, at runtime, with a rule that runs before the Core Rule
 * Set: ctl:ruleRemoveById behind a REQUEST_FILENAME condition, or
 * ctl:ruleRemoveTargetById for one variable.
 *
 * Paths and variable names end up inside SecLang, so they are held to a strict
 * character set on input (and again when the directives are built: stored
 * rows can come from an import or a replica sync). Nothing outside that set
 * can reach a directive.
 */
import { ANOMALY_EVALUATION_RULE_IDS } from "./waf-tuning";

export const WAF_EXCLUSION_PATH_MATCHES = ["exact", "prefix"] as const;
export type WafExclusionPathMatch = (typeof WAF_EXCLUSION_PATH_MATCHES)[number];

/** Rule ids are what Coraza's id action takes; ClickHouse stores them as Int32. */
export const MAX_WAF_RULE_ID = 2_147_483_647;
export const MAX_EXCLUSION_PATH_LENGTH = 1024;
export const MAX_EXCLUSION_VARIABLE_KEY_LENGTH = 256;
export const MAX_EXCLUSION_REASON_LENGTH = 500;

/**
 * Generated exclusion rules take the id WAF_EXCLUSION_RULE_ID_BASE plus the
 * exclusion's id: far above the CRS (900000-999999) and the ids custom rules
 * use, and below Int32's maximum.
 */
export const WAF_EXCLUSION_RULE_ID_BASE = 1_900_000_000;
const MAX_EXCLUSION_RECORD_ID = MAX_WAF_RULE_ID - WAF_EXCLUSION_RULE_ID_BASE;

/**
 * Variables an exclusion can name. `keyed` collections take an optional key
 * (`ARGS:content`); without one the rule skips the whole collection. The
 * others are single values and take no key.
 */
export const WAF_EXCLUSION_COLLECTIONS: Record<string, { keyed: boolean }> = {
  ARGS: { keyed: true },
  ARGS_GET: { keyed: true },
  ARGS_POST: { keyed: true },
  ARGS_NAMES: { keyed: true },
  ARGS_GET_NAMES: { keyed: true },
  ARGS_POST_NAMES: { keyed: true },
  REQUEST_HEADERS: { keyed: true },
  REQUEST_HEADERS_NAMES: { keyed: true },
  REQUEST_COOKIES: { keyed: true },
  REQUEST_COOKIES_NAMES: { keyed: true },
  FILES: { keyed: true },
  FILES_NAMES: { keyed: true },
  XML: { keyed: false },
  REQUEST_BODY: { keyed: false },
  REQUEST_URI: { keyed: false },
  REQUEST_FILENAME: { keyed: false },
  REQUEST_BASENAME: { keyed: false },
  QUERY_STRING: { keyed: false },
};

/**
 * Characters a path may contain: RFC 3986 path characters without "%" (the
 * path is matched decoded, and "%{" would start a SecLang macro), quotes and
 * backslashes.
 */
const PATH_PATTERN = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@/]*$/;
/** A variable key: letters, digits and the separators argument, header and JSON names use. Never a /regex/. */
const VARIABLE_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.\-[\]]*$/;

export class WafExclusionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WafExclusionInputError";
  }
}

/** An exclusion's matching fields, as stored. */
export type WafExclusionMatch = {
  ruleId: number;
  pathMatch: WafExclusionPathMatch | null;
  path: string | null;
  variable: string | null;
};

/**
 * An exclusion as the config builder reads it: a stored row's matching fields
 * plus its id. Stored values are validated again before use.
 */
export type WafExclusionRule = {
  id: number;
  ruleId: number;
  pathMatch: string | null;
  path: string | null;
  variable: string | null;
};

export function isValidWafRuleId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_WAF_RULE_ID;
}

/** Why `ruleId` cannot be excluded, or null. */
export function ruleIdError(ruleId: unknown): string | null {
  if (!isValidWafRuleId(ruleId)) return `ruleId must be an integer from 1 to ${MAX_WAF_RULE_ID}`;
  if ((ANOMALY_EVALUATION_RULE_IDS as readonly number[]).includes(ruleId)) {
    return `Rule ${ruleId} decides whether a request is blocked; excluding it would turn blocking off. ` +
      "Set the WAF to detection only, or set what happens over the threshold to log only.";
  }
  if (ruleId > WAF_EXCLUSION_RULE_ID_BASE) return `ruleId ${ruleId} is in the range the WAF uses for its own exclusion rules`;
  return null;
}

/** True when the path is one REQUEST_FILENAME can hold after t:normalizePath (no "//", "/./" or "/../"). */
function isNormalizedPath(path: string): boolean {
  const segments = path.split("/").slice(1);
  return segments.every((segment, index) => {
    if (segment === "." || segment === "..") return false;
    // Only the last segment may be empty (a trailing slash).
    return segment !== "" || index === segments.length - 1;
  });
}

/** Why `path` cannot be an exclusion path, or null. */
export function pathError(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "path must be a non-empty string";
  if (path.length > MAX_EXCLUSION_PATH_LENGTH) return `path must be at most ${MAX_EXCLUSION_PATH_LENGTH} characters`;
  if (!PATH_PATTERN.test(path)) {
    return "path must start with / and contain only letters, digits and - . _ ~ ! $ & ( ) * + , ; = : @ / (no spaces, quotes, % or query string); write it decoded";
  }
  if (!isNormalizedPath(path)) return 'path must not contain "//", "/./" or "/../"';
  return null;
}

/** The variable in canonical form (collection in capitals), or why it is invalid. */
export function normalizeVariable(variable: unknown): { variable: string } | { error: string } {
  if (typeof variable !== "string" || variable.trim() === "") return { error: "variable must be a non-empty string" };
  const trimmed = variable.trim();
  const colon = trimmed.indexOf(":");
  const collection = (colon === -1 ? trimmed : trimmed.slice(0, colon)).toUpperCase();
  const key = colon === -1 ? null : trimmed.slice(colon + 1);
  const spec = WAF_EXCLUSION_COLLECTIONS[collection];
  if (!spec) {
    return { error: `variable must name one of ${Object.keys(WAF_EXCLUSION_COLLECTIONS).join(", ")}` };
  }
  if (key === null) return { variable: collection };
  if (!spec.keyed) return { error: `${collection} takes no name after a colon` };
  if (key.length === 0 || key.length > MAX_EXCLUSION_VARIABLE_KEY_LENGTH || !VARIABLE_KEY_PATTERN.test(key)) {
    return {
      error: `the name after ${collection}: must be 1 to ${MAX_EXCLUSION_VARIABLE_KEY_LENGTH} letters, digits, _ . - [ ] and start with a letter, digit or _`,
    };
  }
  return { variable: `${collection}:${key}` };
}

/** Input of an exclusion's matching fields, as an API or form sends it. */
export type WafExclusionMatchInput = {
  ruleId?: unknown;
  path?: unknown;
  pathMatch?: unknown;
  variable?: unknown;
};

/**
 * Validates and normalizes an exclusion's matching fields. A path takes a
 * pathMatch ("exact" or "prefix"; by default "prefix" when the path ends with
 * "/", else "exact"); no path means no pathMatch.
 */
export function parseWafExclusionMatch(
  input: WafExclusionMatchInput,
  options: { anyRuleId?: boolean } = {}
): WafExclusionMatch {
  // anyRuleId: stored and legacy exclusions keep whatever valid rule id they
  // name (the anomaly evaluation rules included); only new input is refused.
  const ruleError = options.anyRuleId
    ? (isValidWafRuleId(input.ruleId) ? null : `ruleId must be an integer from 1 to ${MAX_WAF_RULE_ID}`)
    : ruleIdError(input.ruleId);
  if (ruleError) throw new WafExclusionInputError(ruleError);
  const ruleId = input.ruleId as number;

  let path: string | null = null;
  let pathMatch: WafExclusionPathMatch | null = null;
  if (input.path !== undefined && input.path !== null && input.path !== "") {
    const error = pathError(input.path);
    if (error) throw new WafExclusionInputError(error);
    path = input.path as string;
    if (input.pathMatch === undefined || input.pathMatch === null) {
      pathMatch = path.endsWith("/") ? "prefix" : "exact";
    } else if ((WAF_EXCLUSION_PATH_MATCHES as readonly unknown[]).includes(input.pathMatch)) {
      pathMatch = input.pathMatch as WafExclusionPathMatch;
    } else {
      throw new WafExclusionInputError("pathMatch must be exact or prefix");
    }
  } else if (input.pathMatch !== undefined && input.pathMatch !== null) {
    throw new WafExclusionInputError("pathMatch needs a path");
  }

  let variable: string | null = null;
  if (input.variable !== undefined && input.variable !== null && input.variable !== "") {
    const normalized = normalizeVariable(input.variable);
    if ("error" in normalized) throw new WafExclusionInputError(normalized.error);
    variable = normalized.variable;
  }
  return { ruleId, pathMatch, path, variable };
}

/** True when the exclusion covers the whole scope: no path and no variable. */
export function isWholeScopeExclusion(match: Pick<WafExclusionMatch, "path" | "variable">): boolean {
  return !match.path && !match.variable;
}

/** The SecLang rule id generated for exclusion `id`, or null when the id is out of range. */
export function exclusionRuleIdFor(id: number): number | null {
  return Number.isInteger(id) && id >= 1 && id <= MAX_EXCLUSION_RECORD_ID ? WAF_EXCLUSION_RULE_ID_BASE + id : null;
}

/** The directives exclusions add to a WAF handler. */
export type ExclusionDirectives = {
  /** Rule ids removed from the handler (SecRuleRemoveById, after the rules are loaded). */
  removedRuleIds: number[];
  /** Runtime exclusion rules, placed before the rules they exclude. */
  rules: string[];
  /** Rule ids the runtime rules take (a custom rule may not reuse them). */
  ruleIds: number[];
  /** Stored exclusions left out because a field no longer passes validation. */
  skipped: WafExclusionRule[];
};

/**
 * The directives for a handler's exclusions (global ones first, then the
 * host's). Every field is validated again; an exclusion that fails is left
 * out (and reported in `skipped`) rather than written into SecLang.
 */
export function buildExclusionDirectives(exclusions: readonly WafExclusionRule[]): ExclusionDirectives {
  const removed = new Set<number>();
  const rules: string[] = [];
  const ruleIds: number[] = [];
  const skipped: WafExclusionRule[] = [];
  const seen = new Set<string>();

  for (const exclusion of exclusions) {
    let match: WafExclusionMatch;
    try {
      match = parseWafExclusionMatch(
        {
          ruleId: exclusion.ruleId,
          path: exclusion.path,
          pathMatch: exclusion.path ? exclusion.pathMatch : undefined,
          variable: exclusion.variable,
        },
        { anyRuleId: true }
      );
    } catch {
      skipped.push(exclusion);
      continue;
    }
    if (isWholeScopeExclusion(match)) {
      removed.add(match.ruleId);
      continue;
    }
    const key = JSON.stringify([match.ruleId, match.pathMatch, match.path, match.variable]);
    if (seen.has(key)) continue;
    const ruleId = exclusionRuleIdFor(exclusion.id);
    if (ruleId === null) {
      skipped.push(exclusion);
      continue;
    }
    seen.add(key);
    ruleIds.push(ruleId);
    const ctl = match.variable
      ? `ctl:ruleRemoveTargetById=${match.ruleId};${match.variable}`
      : `ctl:ruleRemoveById=${match.ruleId}`;
    if (match.path) {
      const operator = match.pathMatch === "prefix" ? "@beginsWith" : "@streq";
      // REQUEST_FILENAME is the decoded path without the query string;
      // normalizePath resolves "." and ".." segments and repeated slashes, so
      // /allowed/../admin is not taken for a path under /allowed/.
      rules.push(
        `SecRule REQUEST_FILENAME "${operator} ${match.path}" "id:${ruleId},phase:1,pass,t:none,t:normalizePath,nolog,${ctl}"`
      );
    } else {
      rules.push(`SecAction "id:${ruleId},phase:1,pass,t:none,nolog,${ctl}"`);
    }
  }
  return { removedRuleIds: [...removed].sort((a, b) => a - b), rules, ruleIds, skipped };
}
