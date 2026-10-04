// SPDX-License-Identifier: Elastic-2.0
/**
 * An approximate evaluator of feed rules against a pack's sample requests,
 * for publishers (ee/scripts/rule-feed-sign.ts refuses a pack whose samples
 * contradict its rules) and tests. It models the variables, transformations
 * and operators a feed rule may use closely enough to catch a rule that does
 * not match its own example attack, or matches the harmless request next to
 * it; it is not Coraza. Operators it cannot model (@detectSQLi, @detectXSS,
 * @ipMatch, the @validate ones) and variables a sample does not carry make a
 * result "unknown". Pure.
 */
import { validatePackRules, type ParsedRule, type ParsedVariable } from "./seclang";
import type { PackSample, RulePack } from "./types";

type Collection = Array<{ name: string; value: string }>;

/** What a sample request holds, as the variables a rule reads it. */
type SampleTransaction = {
  single: Record<string, string>;
  collections: Record<string, Collection>;
};

/** %XX (and with `unicode`, %uXXXX) decoding; `plus` turns + into a space. Invalid escapes stay as they are. */
function percentDecode(text: string, { plus = false, unicode = false } = {}): string {
  const bytes: number[] = [];
  const pushText = (part: string) => bytes.push(...Buffer.from(part, "utf8"));
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "%" && unicode && /^[uU][0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 6))) {
      pushText(String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)));
      i += 5;
    } else if (c === "%" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c === "+" && plus) {
      bytes.push(0x20);
    } else {
      pushText(c);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function parseUrlEncoded(text: string): Collection {
  if (!text) return [];
  return text.split("&").filter(Boolean).map((pair) => {
    const equals = pair.indexOf("=");
    const name = equals === -1 ? pair : pair.slice(0, equals);
    const value = equals === -1 ? "" : pair.slice(equals + 1);
    return { name: percentDecode(name, { plus: true }), value: percentDecode(value, { plus: true }) };
  });
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") out.pop();
    else if (segment !== "." && segment !== "") out.push(segment);
  }
  return `${path.startsWith("/") ? "/" : ""}${out.join("/")}${path.endsWith("/") && out.length > 0 ? "/" : ""}`;
}

/** The variables of a sample request in a phase (2 adds the urlencoded body). */
export function sampleTransaction(sample: PackSample, phase: 1 | 2): SampleTransaction {
  const query = sample.path.includes("?") ? sample.path.slice(sample.path.indexOf("?") + 1) : "";
  const rawPath = sample.path.split("?")[0];
  const filename = percentDecode(rawPath);
  const headers: Collection = Object.entries(sample.headers ?? {}).map(([name, value]) => ({ name, value }));
  const header = (name: string) => headers.find((entry) => entry.name.toLowerCase() === name)?.value;
  const cookies: Collection = (header("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const equals = part.indexOf("=");
      return equals === -1 ? { name: part, value: "" } : { name: part.slice(0, equals), value: part.slice(equals + 1) };
    });
  const argsGet = parseUrlEncoded(query);
  const body = phase === 2 ? sample.body ?? "" : "";
  const argsPost = phase === 2 && (header("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded") ? parseUrlEncoded(body) : [];
  const names = (collection: Collection): Collection => collection.map((entry) => ({ name: entry.name, value: entry.name }));
  return {
    single: {
      REQUEST_METHOD: sample.method,
      REQUEST_PROTOCOL: "HTTP/1.1",
      REQUEST_URI: sample.path,
      REQUEST_URI_RAW: sample.path,
      REQUEST_LINE: `${sample.method} ${sample.path} HTTP/1.1`,
      QUERY_STRING: query,
      REQUEST_FILENAME: filename,
      REQUEST_BASENAME: filename.slice(filename.lastIndexOf("/") + 1),
      REQUEST_BODY: body,
      REQUEST_BODY_LENGTH: String(Buffer.byteLength(body, "utf8")),
      ARGS_COMBINED_SIZE: String([...argsGet, ...argsPost].reduce((sum, arg) => sum + arg.name.length + arg.value.length, 0)),
    },
    collections: {
      ARGS: [...argsGet, ...argsPost],
      ARGS_GET: argsGet,
      ARGS_POST: argsPost,
      ARGS_NAMES: names([...argsGet, ...argsPost]),
      ARGS_GET_NAMES: names(argsGet),
      ARGS_POST_NAMES: names(argsPost),
      REQUEST_HEADERS: headers,
      REQUEST_HEADERS_NAMES: names(headers),
      REQUEST_COOKIES: cookies,
      REQUEST_COOKIES_NAMES: names(cookies),
    },
  };
}

type Values = { values: string[]; unknown: boolean };

function selectEntries(collection: Collection, variable: ParsedVariable): Collection {
  if (variable.key === null) return collection;
  if (variable.key.startsWith("/") && variable.key.endsWith("/")) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(variable.key.slice(1, -1), "i");
    } catch {
      return [];
    }
    return collection.filter((entry) => pattern.test(entry.name));
  }
  return collection.filter((entry) => entry.name.toLowerCase() === variable.key!.toLowerCase());
}

function variableValues(rule: ParsedRule, tx: SampleTransaction): Values {
  const values: string[] = [];
  let unknown = false;
  const excluded = rule.variables.filter((variable) => variable.negated);
  for (const variable of rule.variables) {
    if (variable.negated) continue;
    if (variable.name in tx.single) {
      values.push(tx.single[variable.name]);
      continue;
    }
    const collection = tx.collections[variable.name];
    if (!collection) {
      // TX, MATCHED_VAR, FILES, REMOTE_ADDR, ...: not in a sample.
      unknown = true;
      continue;
    }
    let entries = selectEntries(collection, variable);
    for (const exclusion of excluded.filter((item) => item.name === variable.name)) {
      const removed = new Set(selectEntries(collection, exclusion));
      entries = entries.filter((entry) => !removed.has(entry));
    }
    if (variable.count) values.push(String(entries.length));
    else values.push(...entries.map((entry) => entry.value));
  }
  return { values, unknown };
}

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The transformation, or null when this evaluator does not model it. */
function transform(name: string, value: string): string | null {
  switch (name) {
    case "lowercase":
      return value.toLowerCase();
    case "uppercase":
      return value.toUpperCase();
    case "urlDecode":
      return percentDecode(value, { plus: true });
    case "urlDecodeUni":
      return percentDecode(value, { plus: true, unicode: true });
    case "trim":
      return value.trim();
    case "trimLeft":
      return value.trimStart();
    case "trimRight":
      return value.trimEnd();
    case "compressWhitespace":
      return value.replace(/\s+/g, " ");
    case "removeWhitespace":
      return value.replace(/\s+/g, "");
    case "removeNulls":
      return value.replace(/\0/g, "");
    case "replaceNulls":
      return value.replace(/\0/g, " ");
    case "length":
      return String(Buffer.byteLength(value, "utf8"));
    case "normalizePath":
    case "normalisePath":
      return normalizePath(value);
    case "normalizePathWin":
    case "normalisePathWin":
      return normalizePath(value.replace(/\\/g, "/"));
    case "htmlEntityDecode":
      return value
        .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
        .replace(/&([a-z]+);/gi, (whole, entity: string) => HTML_ENTITIES[entity.toLowerCase()] ?? whole);
    case "base64Decode":
    case "base64DecodeExt":
      return Buffer.from(value, "base64").toString("utf8");
    case "hexDecode":
      return /^([0-9a-f]{2})*$/i.test(value) ? Buffer.from(value, "hex").toString("utf8") : value;
    default:
      return null;
  }
}

function regexOf(pattern: string): RegExp | null {
  const leading = /^\(\?([imsU]+)\)/.exec(pattern);
  const flags = [...new Set((leading?.[1] ?? "").replace(/U/g, "").split(""))].join("");
  const body = (leading ? pattern.slice(leading[0].length) : pattern).replace(/\(\?[imsU-]+\)/g, "").replace(/\(\?[imsU-]+:/g, "(?:");
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

/** Whether the operator matches a value; null when this evaluator cannot tell. */
function operatorMatches(operator: ParsedRule["operator"], value: string): boolean | null {
  const argument = operator.argument ?? "";
  let result: boolean | null;
  switch (operator.name) {
    case "rx": {
      const regex = regexOf(argument);
      result = regex ? regex.test(value) : null;
      break;
    }
    case "pm":
      result = argument.toLowerCase().split(" ").filter(Boolean).some((phrase) => value.toLowerCase().includes(phrase));
      break;
    case "streq":
      result = value === argument;
      break;
    case "contains":
      result = value.includes(argument);
      break;
    case "beginsWith":
      result = value.startsWith(argument);
      break;
    case "endsWith":
      result = value.endsWith(argument);
      break;
    case "within":
      result = argument.includes(value);
      break;
    case "eq":
    case "ge":
    case "gt":
    case "le":
    case "lt": {
      const number = Number.parseInt(value, 10) || 0;
      const target = Number(argument);
      result = { eq: number === target, ge: number >= target, gt: number > target, le: number <= target, lt: number < target }[operator.name];
      break;
    }
    default:
      result = null;
  }
  return result === null ? null : operator.negated ? !result : result;
}

/** Whether one rule (not its chain) matches the sample; null when unknown. */
function ruleMatches(rule: ParsedRule, tx: SampleTransaction): boolean | null {
  const { values, unknown } = variableValues(rule, tx);
  let undecided = unknown;
  for (const raw of values) {
    let value: string | null = raw;
    for (const name of rule.transformations) {
      value = transform(name, value);
      if (value === null) break;
    }
    if (value === null) {
      undecided = true;
      continue;
    }
    const matched = operatorMatches(rule.operator, value);
    if (matched === true) return true;
    if (matched === null) undecided = true;
  }
  // A negated operator over no value at all: Coraza runs it once on nothing.
  if (values.length === 0 && rule.operator.negated && !unknown) return operatorMatches(rule.operator, "") ?? null;
  return undecided ? null : false;
}

/** Whether any rule chain of the pack matches the sample; null when unknown. */
export function packMatchesSample(rules: readonly ParsedRule[], sample: PackSample): boolean | null {
  let undecided = false;
  let chain: ParsedRule[] = [];
  const chains: ParsedRule[][] = [];
  for (const rule of rules) {
    chain.push(rule);
    if (!rule.chain) {
      chains.push(chain);
      chain = [];
    }
  }
  for (const links of chains) {
    const tx = sampleTransaction(sample, links[0].phase ?? 2);
    let all: boolean | null = true;
    for (const link of links) {
      const matched = ruleMatches(link, tx);
      if (matched === false) {
        all = false;
        break;
      }
      if (matched === null) all = null;
    }
    if (all === true) return true;
    if (all === null) undecided = true;
  }
  return undecided ? null : false;
}

export type SampleCheck = {
  /** Samples that contradict the rules: a positive one not matched, a negative one matched. */
  problems: string[];
  /** Samples this evaluator could not decide. */
  unchecked: string[];
};

/** Checks every sample of a pack against its rules (approximately; see the module comment). */
export function checkPackSamples(pack: Pick<RulePack, "id" | "rules" | "samples">): SampleCheck {
  const { rules } = validatePackRules(pack.rules, `pack ${pack.id}`);
  const result: SampleCheck = { problems: [], unchecked: [] };
  const describe = (sample: PackSample) => `${sample.method} ${sample.path}`;
  pack.samples.positive.forEach((sample, index) => {
    const matched = packMatchesSample(rules, sample);
    if (matched === false) result.problems.push(`positive sample ${index + 1} (${describe(sample)}) does not match`);
    if (matched === null) result.unchecked.push(`positive sample ${index + 1} (${describe(sample)})`);
  });
  pack.samples.negative.forEach((sample, index) => {
    const matched = packMatchesSample(rules, sample);
    if (matched === true) result.problems.push(`negative sample ${index + 1} (${describe(sample)}) matches`);
    if (matched === null) result.unchecked.push(`negative sample ${index + 1} (${describe(sample)})`);
  });
  return result;
}
