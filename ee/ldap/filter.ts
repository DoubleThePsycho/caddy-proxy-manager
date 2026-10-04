// SPDX-License-Identifier: Elastic-2.0
/**
 * Search filters and distinguished names for directory sign-in.
 *
 * What a person types only ever reaches the directory as an RFC 4515
 * assertion value, escaped here, inside a filter an administrator wrote. It
 * never becomes part of a DN: the DN that is bound is the one the directory
 * returned for the single entry the search found.
 */
import { FilterParser } from "ldapts";
import { LIMITS } from "./constants";

/**
 * RFC 4515 escaping of an assertion value: the filter syntax characters
 * ( ) * \ and NUL, plus every other control character, as \XX. Everything else,
 * UTF-8 included, is a literal.
 */
export function escapeFilterValue(value: string): string {
  let escaped = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "*" || char === "(" || char === ")" || char === "\\" || code < 0x20 || code === 0x7f) {
      escaped += `\\${code.toString(16).padStart(2, "0")}`;
    } else {
      escaped += char;
    }
  }
  return escaped;
}

export type FilterPlaceholder = "username" | "dn";

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

/**
 * Fills a filter template: every {name} is replaced with the escaped value.
 * The template was validated when it was saved (validateFilterTemplate).
 */
export function fillFilter(template: string, values: Partial<Record<FilterPlaceholder, string>>): string {
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = values[name as FilterPlaceholder];
    if (value === undefined) throw new Error(`No value for the {${name}} placeholder`);
    return escapeFilterValue(value);
  });
}

/**
 * Why a filter template cannot be used, or null. `allowed` are the
 * placeholders it may hold; at least one of `required` must appear. Each
 * placeholder must stand where an assertion value goes (after "=" inside one
 * filter item), so input can never change an attribute name or the filter's
 * structure, and the template must parse with sample values.
 */
export function filterTemplateProblem(
  template: string,
  allowed: readonly FilterPlaceholder[],
  required: readonly FilterPlaceholder[]
): string | null {
  if (!template.trim()) return "is required";
  if (template.length > LIMITS.filter) return `must be at most ${LIMITS.filter} characters`;
  if (/\p{Cc}/u.test(template)) return "must not contain control characters";
  if (!template.trim().startsWith("(")) return "must be enclosed in parentheses, for example (uid={username})";

  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (!(allowed as readonly string[]).includes(name)) {
      return `may only use ${allowed.map((p) => `{${p}}`).join(" and ")}, not {${name}}`;
    }
    if (!inValuePosition(template, match.index ?? 0)) {
      return `must use {${name}} as a value after "=", for example (uid={username})`;
    }
    found.add(name);
  }
  if (!required.some((name) => found.has(name))) {
    return `must contain ${required.map((p) => `{${p}}`).join(" or ")}`;
  }

  try {
    FilterParser.parseString(fillFilter(template, { username: "probe", dn: "cn=probe,dc=example,dc=com" }));
  } catch {
    return "is not a valid LDAP filter";
  }
  return null;
}

/** Whether index `at` lies after the "=" of the filter item it is in. */
function inValuePosition(template: string, at: number): boolean {
  let itemStart = -1;
  for (let i = 0; i < at; i += 1) {
    const char = template[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "(") itemStart = i;
    if (char === ")") itemStart = -1;
  }
  if (itemStart === -1) return false;
  const head = template.slice(itemStart + 1, at);
  return head.includes("=") && !/[()&|!]/.test(head.slice(0, head.indexOf("=")));
}

const ATTRIBUTE_NAME = /^(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)+)$/;

/** An attribute description: a name such as mail or sAMAccountName, or an OID. */
export function isAttributeName(value: string): boolean {
  return value.length > 0 && value.length <= LIMITS.attribute && ATTRIBUTE_NAME.test(value);
}

/** Why `value` is not a usable distinguished name, or null. Only shape is checked: the server decides. */
export function dnProblem(value: string): string | null {
  if (!value.trim()) return "is required";
  if (value.length > LIMITS.dn) return `must be at most ${LIMITS.dn} characters`;
  if (/\p{Cc}/u.test(value)) return "must not contain control characters";
  if (!/^\s*[A-Za-z0-9][A-Za-z0-9.-]*\s*=/.test(value)) return "must be a distinguished name such as ou=people,dc=example,dc=com";
  return null;
}

/**
 * A DN for comparison: lowercased, without the spaces around separators that
 * RFC 4514 lets servers add or drop. Escaped characters (\, or \2c) are kept
 * as they are, so values that differ only there never compare equal. Group
 * DNs from the directory are compared with the mapped ones this way.
 */
export function normalizeDn(dn: string): string {
  const out: string[] = [];
  let current = "";
  // Characters up to here came from escapes and are never trimmed.
  let kept = 0;
  const flush = () => {
    let end = current.length;
    while (end > kept && current[end - 1] === " ") end -= 1;
    out.push(current.slice(0, end));
    current = "";
    kept = 0;
  };
  const text = dn.trim();
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "\\" && i + 1 < text.length) {
      const step = /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3)) ? 3 : 2;
      current += text.slice(i, i + step);
      kept = current.length;
      i += step;
      continue;
    }
    if (char === "," || char === "+" || char === "=") {
      flush();
      out.push(char);
      i += 1;
      while (text[i] === " ") i += 1;
      continue;
    }
    current += char;
    i += 1;
  }
  flush();
  return out.join("").toLowerCase();
}
