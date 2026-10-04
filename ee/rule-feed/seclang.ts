// SPDX-License-Identifier: Elastic-2.0
/**
 * The SecLang a rule feed may contain, and the rules Ingressi builds from it.
 *
 * A feed rule is one SecRule directive on one line, in exactly this shape:
 *
 *   SecRule VARIABLES "@operator argument" "action,action,..."
 *
 * Everything in it is held to an allowlist: request variables of phases 1
 * and 2, operators that neither read files nor reach the network, known
 * transformations, and only the actions id, phase, t, chain, capture and
 * multiMatch. No other directive (SecRuleEngine, SecRuleRemove*, SecAction,
 * SecDefaultAction, Include, ...) and no other action (ctl, setvar, exec,
 * setenv, skip, deny, nolog, msg, ...) can appear, so a feed can add rules
 * but cannot switch the engine off, remove or change other rules, hide its
 * matches, touch the container or change the anomaly scores the CRS adds up.
 * Rule ids must be in the reserved range (src/lib/waf-exclusions.ts).
 *
 * Ingressi never passes a feed rule through as written: it parses it, checks
 * every part, and renders a new line from the parts. The rendered rule gets
 * the disruptive action of the patch's mode (deny with 403, or pass to only
 * log), a message and tags naming the patch and its CVEs, and logdata in the
 * form the WAF log parser redacts credentials from. Rendered rules must also
 * pass the custom directive filter the Caddy config builder applies
 * (filterCustomDirectives with the virtual patch id range).
 *
 * Pure: no database, no network.
 */
import { filterCustomDirectives } from "@/src/lib/caddy-waf";
import { isVirtualPatchRuleId, VIRTUAL_PATCH_RULE_ID_MAX, VIRTUAL_PATCH_RULE_ID_MIN } from "@/src/lib/waf-exclusions";
import { RULE_FEED_LIMITS, type PackSeverity } from "./types";

/** A feed that cannot be used; the message is safe to show and names what is wrong. */
export class RuleFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleFeedError";
  }
}

/** Request variables a feed rule may read, and whether each is a collection that takes a key. */
const VARIABLES: Record<string, { collection: boolean; body?: boolean }> = {
  ARGS: { collection: true, body: true },
  ARGS_GET: { collection: true },
  ARGS_POST: { collection: true, body: true },
  ARGS_NAMES: { collection: true, body: true },
  ARGS_GET_NAMES: { collection: true },
  ARGS_POST_NAMES: { collection: true, body: true },
  ARGS_COMBINED_SIZE: { collection: false, body: true },
  QUERY_STRING: { collection: false },
  REQUEST_BASENAME: { collection: false },
  REQUEST_BODY: { collection: false, body: true },
  REQUEST_BODY_LENGTH: { collection: false, body: true },
  REQUEST_COOKIES: { collection: true },
  REQUEST_COOKIES_NAMES: { collection: true },
  REQUEST_FILENAME: { collection: false },
  REQUEST_HEADERS: { collection: true },
  REQUEST_HEADERS_NAMES: { collection: true },
  REQUEST_LINE: { collection: false },
  REQUEST_METHOD: { collection: false },
  REQUEST_PROTOCOL: { collection: false },
  REQUEST_URI: { collection: false },
  REQUEST_URI_RAW: { collection: false },
  FILES: { collection: true, body: true },
  FILES_NAMES: { collection: true, body: true },
  FILES_SIZES: { collection: true, body: true },
  FILES_COMBINED_SIZE: { collection: false, body: true },
  REQBODY_PROCESSOR: { collection: false, body: true },
  REQBODY_ERROR: { collection: false, body: true },
  REMOTE_ADDR: { collection: false },
  MATCHED_VAR: { collection: false },
  MATCHED_VAR_NAME: { collection: false },
  MATCHED_VARS: { collection: true },
  MATCHED_VARS_NAMES: { collection: true },
  // Only the capture groups TX:0 to TX:9 (see VARIABLE_KEYS).
  TX: { collection: true },
};

type OperatorKind = "regex" | "phrases" | "text" | "integer" | "addresses" | "byte_ranges" | "none";

/**
 * Operators a feed rule may use: none reads a file, runs a program or makes
 * a network request, and each one is registered in Coraza v3.7.0 (an unknown
 * operator or transformation makes Caddy refuse the whole configuration).
 */
const OPERATORS: Record<string, OperatorKind> = {
  rx: "regex",
  pm: "phrases",
  streq: "text",
  strmatch: "text",
  contains: "text",
  beginsWith: "text",
  endsWith: "text",
  within: "text",
  eq: "integer",
  ge: "integer",
  gt: "integer",
  le: "integer",
  lt: "integer",
  ipMatch: "addresses",
  validateByteRange: "byte_ranges",
  detectSQLi: "none",
  detectXSS: "none",
  validateUrlEncoding: "none",
  validateUtf8Encoding: "none",
};

/** Transformations a feed rule may apply, spelt as Coraza registers them. */
const TRANSFORMATIONS = new Set([
  "none",
  "base64Decode",
  "base64DecodeExt",
  "cmdLine",
  "compressWhitespace",
  "cssDecode",
  "escapeSeqDecode",
  "hexDecode",
  "htmlEntityDecode",
  "jsDecode",
  "length",
  "lowercase",
  "normalisePath",
  "normalizePath",
  "normalisePathWin",
  "normalizePathWin",
  "removeComments",
  "removeCommentsChar",
  "removeNulls",
  "removeWhitespace",
  "replaceComments",
  "replaceNulls",
  "trim",
  "trimLeft",
  "trimRight",
  "uppercase",
  "urlDecode",
  "urlDecodeUni",
  "utf8toUnicode",
]);

/** The actions a feed rule may carry; the starter of a rule (or chain) also needs id and phase. */
const STARTER_ACTIONS = new Set(["id", "phase", "t", "chain", "capture", "multiMatch"]);
const CHAINED_ACTIONS = new Set(["t", "chain", "capture", "multiMatch"]);

const RULE_SHAPE = /^SecRule ([^ "]+) "([^"]*)" "([^"]*)"$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const VARIABLE = /^(!?)(&?)([A-Z_]+)(?::(.+))?$/;
const PLAIN_KEY = /^[A-Za-z0-9_.-]{1,128}$/;
const REGEX_KEY = /^\/[A-Za-z0-9_.^$*+?()[\]{}-]{1,128}\/$/;
const OPERATOR = /^(!?)@([A-Za-z0-9]+)(?: (.+))?$/;
const ACTION = /^([A-Za-z]+)(?::([A-Za-z0-9]+))?$/;

export type ParsedVariable = { negated: boolean; count: boolean; name: string; key: string | null };

export type ParsedRule = {
  variables: ParsedVariable[];
  operator: { negated: boolean; name: string; argument: string | null };
  /** Set on a rule or chain starter, never on a chained rule. */
  id: number | null;
  phase: 1 | 2 | null;
  /** In order, without "none" (every rendered rule starts with t:none). */
  transformations: string[];
  chain: boolean;
  capture: boolean;
  multiMatch: boolean;
};

function fail(where: string, message: string): never {
  throw new RuleFeedError(`${where}: ${message}`);
}

function parseVariables(text: string, where: string): ParsedVariable[] {
  const parts = text.split("|");
  if (parts.length > 20) fail(where, "a rule may read at most 20 variables");
  return parts.map((part) => {
    const match = VARIABLE.exec(part);
    if (!match) fail(where, `"${part.slice(0, 80)}" is not a variable a feed rule may read`);
    const [, negated, count, name, key] = match;
    const info = VARIABLES[name];
    if (!info) fail(where, `the variable ${name} is not allowed in feed rules`);
    if (negated && count) fail(where, `${part} cannot both exclude and count`);
    if (key !== undefined) {
      if (!info.collection) fail(where, `${name} takes no key`);
      if (name === "TX" ? !/^[0-9]$/.test(key) : !PLAIN_KEY.test(key) && !REGEX_KEY.test(key)) {
        fail(where, `the key of ${name} is not allowed (${name === "TX" ? "only TX:0 to TX:9" : "letters, digits, _ . - or a simple /regex/"})`);
      }
    } else if (negated) {
      fail(where, `excluding ${name} needs a key`);
    } else if (name === "TX") {
      fail(where, "TX needs a key, TX:0 to TX:9");
    }
    if (count && !info.collection) fail(where, `${name} cannot be counted`);
    return { negated: Boolean(negated), count: Boolean(count), name, key: key ?? null };
  });
}

/**
 * Why `pattern` is not a regular expression RE2 (Coraza's @rx) is sure to
 * compile, or null. Conservative: lookarounds, backreferences, possessive
 * quantifiers, escapes RE2 lacks and repetition counts above 1000 are
 * refused, as is anything JavaScript cannot compile.
 */
export function regexProblem(pattern: string): string | null {
  let inClass = false;
  let afterQuantifier = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) return "it ends with a backslash";
      if (!inClass && /[1-9]/.test(next)) return "backreferences are not supported by Coraza (RE2)";
      if (/[ZGRXKhHeLlUuNcok]/.test(next)) return `\\${next} is not supported by Coraza (RE2)`;
      i++;
      afterQuantifier = false;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      // A leading ^ and a ] right after the bracket are part of the class.
      if (pattern[i + 1] === "^") i++;
      if (pattern[i + 1] === "]") i++;
      afterQuantifier = false;
      continue;
    }
    if (c === "(" && pattern[i + 1] === "?") {
      const rest = pattern.slice(i + 2);
      if (!/^[imsU-]*:/.test(rest) && !/^[imsU-]+\)/.test(rest)) {
        return "only (?:...) groups and (?flags) are supported (no lookarounds, atomic or named groups)";
      }
      afterQuantifier = false;
      continue;
    }
    const repeat = c === "{" ? /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i)) : null;
    if (c === "*" || c === "+" || c === "?" || repeat) {
      if (afterQuantifier) {
        // A lazy quantifier (*? +? ?? {n}?) is fine; anything else repeats a repetition.
        if (c === "?") {
          afterQuantifier = false;
          continue;
        }
        return "possessive and nested quantifiers are not supported by Coraza (RE2)";
      }
      if (repeat) {
        if (Number(repeat[1]) > 1000 || (repeat[2] && Number(repeat[2]) > 1000)) return "repetition counts above 1000 are not supported";
        i += repeat[0].length - 1;
      }
      afterQuantifier = true;
      continue;
    }
    afterQuantifier = false;
  }
  if (inClass) return "a character class is not closed";
  // JavaScript has no leading (?flags) group: turn one into flags, and inline
  // flag groups into plain groups, to check the rest compiles.
  const leading = /^\(\?([imsU]+)\)/.exec(pattern);
  const flags = [...new Set((leading?.[1] ?? "").replace(/U/g, "").split(""))].join("");
  const body = (leading ? pattern.slice(leading[0].length) : pattern).replace(/\(\?[imsU-]+\)/g, "").replace(/\(\?[imsU-]+:/g, "(?:");
  try {
    new RegExp(body, flags);
  } catch {
    return "it is not a valid regular expression";
  }
  return null;
}

function checkOperatorArgument(kind: OperatorKind, name: string, argument: string | null, where: string): void {
  if (kind === "none") {
    if (argument !== null) fail(where, `@${name} takes no argument`);
    return;
  }
  if (argument === null) fail(where, `@${name} needs an argument`);
  if (argument.length > RULE_FEED_LIMITS.operatorArgumentLength) {
    fail(where, `the argument of @${name} is longer than ${RULE_FEED_LIMITS.operatorArgumentLength} characters`);
  }
  if (argument !== argument.trim()) fail(where, `the argument of @${name} starts or ends with a space`);
  // A macro would expand transaction data into the operator; a trailing
  // backslash would escape the closing quote.
  if (argument.includes("%{")) fail(where, "macros (%{...}) are not allowed in operator arguments");
  if (argument.endsWith("\\")) fail(where, `the argument of @${name} ends with a backslash`);
  switch (kind) {
    case "regex": {
      const problem = regexProblem(argument);
      if (problem) fail(where, `the regular expression is refused: ${problem}`);
      return;
    }
    case "integer":
      if (!/^-?\d{1,10}$/.test(argument)) fail(where, `@${name} takes an integer`);
      return;
    case "addresses":
      if (!/^[0-9A-Fa-f:./]+(?:,\s?[0-9A-Fa-f:./]+){0,99}$/.test(argument)) fail(where, "@ipMatch takes addresses and CIDR ranges separated by commas");
      return;
    case "byte_ranges": {
      const ranges = argument.split(",").map((part) => part.trim());
      const valid = ranges.every((range) => {
        const match = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(range);
        return match !== null && Number(match[1]) <= 255 && (match[2] === undefined || (Number(match[2]) <= 255 && Number(match[2]) >= Number(match[1])));
      });
      if (!valid) fail(where, "@validateByteRange takes byte values and ranges from 0 to 255, separated by commas");
      return;
    }
    default:
      return;
  }
}

/**
 * Parses one feed rule, the starter of a rule or chain (`chained` false) or
 * a rule that a chain continues into (`chained` true). Throws RuleFeedError
 * naming the first thing that is not allowed.
 */
export function parseFeedRule(text: unknown, chained: boolean, where: string): ParsedRule {
  if (typeof text !== "string" || text.length === 0) fail(where, "a rule must be a non-empty string");
  if (text.length > RULE_FEED_LIMITS.ruleLength) fail(where, `a rule is longer than ${RULE_FEED_LIMITS.ruleLength} characters`);
  // One line of printable ASCII: no line breaks, tabs or Unicode spaces that
  // Coraza's parser would read differently.
  if (!PRINTABLE_ASCII.test(text)) fail(where, "a rule must be one line of printable ASCII");
  const shape = RULE_SHAPE.exec(text);
  if (!shape) {
    const directive = /^\s*([A-Za-z]+)/.exec(text)?.[1];
    if (directive && directive !== "SecRule") fail(where, `the directive ${directive} is not allowed in feed rules (only SecRule)`);
    fail(where, 'a rule must read SecRule VARIABLES "@operator argument" "actions" with single spaces');
  }
  const [, variableText, operatorText, actionText] = shape;
  const variables = parseVariables(variableText, where);

  const operatorMatch = OPERATOR.exec(operatorText);
  if (!operatorMatch) fail(where, "the operator must be written @name or @name argument");
  const [, negated, operatorName, argument] = operatorMatch;
  const kind = OPERATORS[operatorName];
  if (!kind) fail(where, `the operator @${operatorName} is not allowed in feed rules`);
  checkOperatorArgument(kind, operatorName, argument ?? null, where);

  if (actionText.length === 0) {
    if (!chained) fail(where, "a rule needs at least the id and phase actions");
  }
  const allowed = chained ? CHAINED_ACTIONS : STARTER_ACTIONS;
  const rule: ParsedRule = {
    variables,
    operator: { negated: Boolean(negated), name: operatorName, argument: argument ?? null },
    id: null,
    phase: null,
    transformations: [],
    chain: false,
    capture: false,
    multiMatch: false,
  };
  const seen = new Set<string>();
  for (const item of actionText.length > 0 ? actionText.split(",") : []) {
    const match = ACTION.exec(item);
    const key = match?.[1] ?? /^[A-Za-z]*/.exec(item)?.[0] ?? "";
    if (!allowed.has(key)) {
      fail(where, key ? `the action ${key} is not allowed in ${chained ? "a chained rule" : "feed rules"}` : `"${item.slice(0, 40)}" is not an action`);
    }
    if (!match) fail(where, `the action ${key} is not written key or key:value`);
    const value = match[2];
    if (key !== "t" && seen.has(key)) fail(where, `the action ${key} appears twice`);
    seen.add(key);
    switch (key) {
      case "id": {
        if (!value || !/^\d{1,10}$/.test(value)) fail(where, "id takes a number");
        const id = Number(value);
        if (!isVirtualPatchRuleId(id)) {
          fail(where, `rule id ${id} is outside the range reserved for virtual patches (${VIRTUAL_PATCH_RULE_ID_MIN}-${VIRTUAL_PATCH_RULE_ID_MAX})`);
        }
        rule.id = id;
        break;
      }
      case "phase":
        if (value !== "1" && value !== "2") fail(where, "phase must be 1 or 2 (request headers or request body)");
        rule.phase = Number(value) as 1 | 2;
        break;
      case "t":
        if (!value || !TRANSFORMATIONS.has(value)) fail(where, `the transformation t:${value ?? ""} is not allowed`);
        if (value !== "none") rule.transformations.push(value);
        break;
      default:
        if (value !== undefined) fail(where, `the action ${key} takes no value`);
        if (key === "chain") rule.chain = true;
        else if (key === "capture") rule.capture = true;
        else rule.multiMatch = true;
    }
  }
  if (!chained && (rule.id === null || rule.phase === null)) fail(where, "a rule needs the id and phase actions");
  return rule;
}

export type ValidatedPackRules = {
  rules: ParsedRule[];
  /** The ids of the rules (chain starters) in order. */
  ruleIds: number[];
  /** Some rule reads the request body (phase 2 and a body variable). */
  inspectsBody: boolean;
};

/**
 * Validates the rules of a pack: each one parsed and checked, chains
 * complete, ids unique within the pack. `where` prefixes every error.
 */
export function validatePackRules(rules: unknown, where: string): ValidatedPackRules {
  if (!Array.isArray(rules) || rules.length === 0) fail(where, "rules must be a non-empty list");
  if (rules.length > RULE_FEED_LIMITS.rulesPerPack) fail(where, `a pack may have at most ${RULE_FEED_LIMITS.rulesPerPack} rules`);
  const parsed: ParsedRule[] = [];
  const ruleIds: number[] = [];
  let inChain = false;
  let phase: 1 | 2 | null = null;
  let inspectsBody = false;
  rules.forEach((text, index) => {
    const rule = parseFeedRule(text, inChain, `${where}, rule ${index + 1}`);
    if (!inChain) {
      if (ruleIds.includes(rule.id!)) fail(`${where}, rule ${index + 1}`, `rule id ${rule.id} is used twice`);
      ruleIds.push(rule.id!);
      phase = rule.phase;
    }
    if (phase === 2 && rule.variables.some((variable) => VARIABLES[variable.name]?.body)) inspectsBody = true;
    parsed.push(rule);
    inChain = rule.chain;
  });
  if (inChain) fail(where, "the last rule has chain, but no rule follows it");
  return { rules: parsed, ruleIds, inspectsBody };
}

export type RenderablePack = { id: string; title: string; cves: readonly string[]; severity: PackSeverity };

const CORAZA_SEVERITY: Record<PackSeverity, string> = {
  critical: "CRITICAL",
  high: "ERROR",
  medium: "WARNING",
  low: "NOTICE",
};

/** Text for a single-quoted SecLang value: no quotes, commas, backslashes, % or braces. */
function seclangText(text: string, max: number): string {
  return text.replace(/[^A-Za-z0-9 ._:;()/+-]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

function renderVariables(variables: readonly ParsedVariable[]): string {
  return variables
    .map((variable) => `${variable.negated ? "!" : ""}${variable.count ? "&" : ""}${variable.name}${variable.key !== null ? `:${variable.key}` : ""}`)
    .join("|");
}

function renderOperator(operator: ParsedRule["operator"]): string {
  return `${operator.negated ? "!" : ""}@${operator.name}${operator.argument !== null ? ` ${operator.argument}` : ""}`;
}

function renderFlags(rule: ParsedRule): string[] {
  return [
    "t:none",
    ...rule.transformations.map((name) => `t:${name}`),
    ...(rule.capture ? ["capture"] : []),
    ...(rule.multiMatch ? ["multiMatch"] : []),
    ...(rule.chain ? ["chain"] : []),
  ];
}

/** The message rendered rules carry: the CVE ids and the title. */
export function patchRuleMessage(pack: Pick<RenderablePack, "title" | "cves">): string {
  return seclangText(`${pack.cves.join(" ")} ${pack.title}`, 200) || "Virtual patch";
}

/**
 * The SecRule lines of a pack in a mode: block denies matching requests with
 * 403, detect only logs them. Only parsed, validated parts and generated text
 * reach the output.
 */
export function renderPackRules(pack: RenderablePack, rules: readonly ParsedRule[], mode: "detect" | "block"): string[] {
  const message = patchRuleMessage(pack);
  const disruptive = mode === "block" ? ["deny", "status:403"] : ["pass"];
  const tags = [
    "tag:'ingressi/virtual-patch'",
    `tag:'virtual-patch/${seclangText(pack.id, 64)}'`,
    ...pack.cves.map((cve) => `tag:'${seclangText(cve, 32)}'`),
  ];
  let starter = true;
  return rules.map((rule) => {
    const actions = starter
      ? [
          `id:${rule.id}`,
          `phase:${rule.phase}`,
          ...disruptive,
          "log",
          "auditlog",
          `msg:'${message}'`,
          // The form the WAF log parser recognises when it redacts credentials.
          "logdata:'Matched Data: %{MATCHED_VAR} found within %{MATCHED_VAR_NAME}'",
          `severity:'${CORAZA_SEVERITY[pack.severity]}'`,
          ...tags,
          ...renderFlags(rule),
        ]
      : renderFlags(rule);
    starter = !rule.chain;
    return `SecRule ${renderVariables(rule.variables)} "${renderOperator(rule.operator)}" "${actions.join(",")}"`;
  });
}

/**
 * Validates a pack's rules and checks that both renderings pass the filter
 * the Caddy config builder applies, so a verified pack is never dropped
 * there. Returns the validated rules.
 */
export function validateRenderablePack(pack: RenderablePack, rules: unknown, where: string): ValidatedPackRules {
  const validated = validatePackRules(rules, where);
  for (const mode of ["detect", "block"] as const) {
    const rendered = renderPackRules(pack, validated.rules, mode).join("\n");
    const { dropped } = filterCustomDirectives(rendered, { ruleIdRange: "virtual_patch" });
    if (dropped.length > 0) fail(where, `a rendered rule would not be applied: ${dropped[0].reason}`);
  }
  return validated;
}
