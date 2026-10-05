/**
 * What the Access lists pages say about a list in plain words ("Allows only
 * 203.0.113.0/26 and private networks · basic auth for 2 users"), the
 * mistakes worth a warning (a list that denies everyone, allow rules that
 * change nothing) and the searches. Pure, so it is unit-tested without a
 * browser.
 */
import {
  PRIVATE_RANGES_VALUE,
  continentName,
  countryName,
  isRuleExpired,
  type AccessListDefaultAction,
  type AccessListRuleAction,
  type AccessListRuleKind,
} from "@/src/lib/access-list-rules";

export type SummaryRule = {
  action: AccessListRuleAction;
  kind: AccessListRuleKind;
  values: readonly string[];
  expiresAt?: string | null;
};

export type SummaryList = {
  rules: readonly SummaryRule[];
  defaultAction: AccessListDefaultAction;
  /** Basic-auth users. */
  memberCount: number;
};

/** Up to this many values are named; more are counted ("4 countries"). */
const NAMED_ADDRESSES = 2;
const NAMED_COUNTRIES = 3;
const NAMED_CONTINENTS = 2;
const NAMED_ASNS = 2;
/** More runs of allow and deny than this are summarised as a rule count. */
const MAX_SEGMENTS = 3;

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function valuesOf(rules: readonly SummaryRule[], kind: AccessListRuleKind): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (rule.kind !== kind) continue;
    for (const value of rule.values) if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** What a group of rules matches: "203.0.113.0/26, private networks, CN, RU and 2 AS numbers". */
export function describeSources(rules: readonly SummaryRule[]): string {
  const parts: string[] = [];
  const ip = valuesOf(rules, "ip");
  const ranges = ip.filter((value) => value !== PRIVATE_RANGES_VALUE);
  if (ranges.length > 0 && ranges.length <= NAMED_ADDRESSES) {
    parts.push(...ranges);
  } else if (ranges.length > 0) {
    const networks = ranges.filter((value) => value.includes("/")).length;
    const addresses = ranges.length - networks;
    if (addresses > 0) parts.push(count(addresses, "address", "addresses"));
    if (networks > 0) parts.push(count(networks, "network", "networks"));
  }
  if (ip.includes(PRIVATE_RANGES_VALUE)) parts.push("private networks");

  const countries = valuesOf(rules, "country");
  if (countries.length > NAMED_COUNTRIES) parts.push(count(countries.length, "country", "countries"));
  else parts.push(...countries);

  const continents = valuesOf(rules, "continent");
  if (continents.length > NAMED_CONTINENTS) parts.push(count(continents.length, "continent", "continents"));
  else parts.push(...continents.map((code) => continentName(code) ?? code));

  const asns = valuesOf(rules, "asn");
  if (asns.length > NAMED_ASNS) parts.push(count(asns.length, "AS number", "AS numbers"));
  else parts.push(...asns.map((asn) => `AS${asn}`));

  return joinAnd(parts);
}

type Segment = { action: AccessListRuleAction; rules: SummaryRule[] };

/**
 * The rules that decide anything, as runs of the same action. Expired and
 * empty rules are left out, and so are the last runs whose action is the
 * default action: they end the same way as no match.
 */
function effectiveSegments(list: SummaryList, now: Date): { active: SummaryRule[]; segments: Segment[] } {
  const active = list.rules.filter((rule) => rule.values.length > 0 && !isRuleExpired({ expiresAt: rule.expiresAt ?? null }, now));
  const segments: Segment[] = [];
  for (const rule of active) {
    const last = segments[segments.length - 1];
    if (last && last.action === rule.action) last.rules.push(rule);
    else segments.push({ action: rule.action, rules: [rule] });
  }
  while (segments.length > 0 && segments[segments.length - 1].action === list.defaultAction) segments.pop();
  return { active, segments };
}

/** What the rules and the default action do, or null when they let everyone in. */
export function describeRules(list: SummaryList, now: Date = new Date()): string | null {
  const { active, segments } = effectiveSegments(list, now);
  if (segments.length === 0) return list.defaultAction === "deny" ? "Denies everyone" : null;
  const verb = (action: AccessListRuleAction) => (action === "allow" ? "allows" : "denies");
  if (segments.length === 1) {
    const [only] = segments;
    // One run, the opposite of the default: an allowlist or a blocklist.
    return only.action === "allow" ? `Allows only ${describeSources(only.rules)}` : `Denies ${describeSources(only.rules)}`;
  }
  const rest = list.defaultAction === "deny" ? "denies everyone else" : "allows everyone else";
  if (segments.length > MAX_SEGMENTS) return `${count(active.length, "rule", "rules")}; ${rest}`;
  const steps = segments.map((segment) => `${verb(segment.action)} ${describeSources(segment.rules)}`).join(", then ");
  return `${capitalize(steps)}; ${rest}`;
}

/** The whole list in one line: "Allows only 203.0.113.0/26 · basic auth for 2 users". */
export function describeAccessList(list: SummaryList, now: Date = new Date()): string {
  const rules = describeRules(list, now);
  const auth = list.memberCount > 0 ? `basic auth for ${count(list.memberCount, "user", "users")}` : null;
  if (rules && auth) return `${rules} · ${auth}`;
  if (auth) return capitalize(auth);
  return rules ?? "Lets everyone in";
}

export type ListWarning = "denies_everyone" | "allow_rules_unused";

/**
 * Mistakes the editor points out: a list that denies every request (no
 * rule lets anyone in and everyone else is denied), and allow rules that
 * change nothing because everyone else is allowed too.
 */
export function listWarning(list: SummaryList, now: Date = new Date()): ListWarning | null {
  const { active, segments } = effectiveSegments(list, now);
  if (list.defaultAction === "deny" && !segments.some((segment) => segment.action === "allow")) return "denies_everyone";
  if (list.defaultAction === "allow" && active.length > 0 && segments.length === 0) return "allow_rules_unused";
  return null;
}

// ── Search ─────────────────────────────────────────────────────────────

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** Words of `query` that all have to appear somewhere in `fields`. */
function matchesAll(fields: readonly (string | null | undefined)[], query: string): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

function ruleSearchText(rule: SummaryRule & { note?: string | null }): string[] {
  const out = [...rule.values, rule.note ?? ""];
  for (const value of rule.values) {
    if (rule.kind === "asn") out.push(`AS${value}`);
    if (rule.kind === "country") out.push(countryName(value) ?? "");
    if (rule.kind === "continent") out.push(continentName(value) ?? "");
  }
  return out;
}

/** A list matches by its name, description, rule values and notes, users, and the hosts using it. */
export function matchesListSearch(
  list: {
    name: string;
    description: string | null;
    rules: readonly (SummaryRule & { note?: string | null })[];
    entries: readonly { username: string }[];
  },
  hosts: readonly { name: string; domains: readonly string[] }[],
  query: string
): boolean {
  return matchesAll(
    [
      list.name,
      list.description,
      ...list.rules.flatMap(ruleSearchText),
      ...list.entries.map((entry) => entry.username),
      ...hosts.flatMap((host) => [host.name, ...host.domains]),
    ],
    query
  );
}

/** A Blocked sources entry matches by its values (and country or continent names) and its reason. */
export function matchesBlockedSearch(rule: SummaryRule & { note?: string | null }, query: string): boolean {
  return matchesAll(ruleSearchText(rule), query);
}
