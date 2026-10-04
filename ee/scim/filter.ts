// SPDX-License-Identifier: Elastic-2.0
/**
 * The parts of the SCIM filter and attribute-path grammar (RFC 7644 sections
 * 3.4.2.2 and 3.5.2) that identity providers send:
 *
 *  - list filters `userName eq "alice@example.com"`, `externalId eq "..."`,
 *    `displayName eq "..."` (one comparison, operator eq);
 *  - PATCH paths `active`, `name.givenName`, `emails[type eq "work"].value`,
 *    `members[value eq "42"]`, optionally prefixed with the core schema URN.
 *
 * Attribute names are not case-sensitive; they come back lowercased.
 */
import { ScimError, stripCoreSchema } from "./protocol";

export type FilterValue = string | number | boolean | null;

export type Comparison = {
  /** Lowercased attribute path, e.g. "username" or "emails.value". */
  attribute: string;
  value: FilterValue;
};

export type ParsedPath = {
  /** Lowercased top-level attribute ("emails"), or the lowercased URN path of an extension attribute. */
  attribute: string;
  /** The value filter in brackets, e.g. type eq "work". */
  filter: Comparison | null;
  /** Lowercased sub-attribute after the dot, e.g. "value" or "givenname". */
  subAttribute: string | null;
};

const MAX_FILTER_LENGTH = 1000;

function parseValue(text: string, invalid: () => ScimError): FilterValue {
  const value = text.trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through
    }
    throw invalid();
  }
  const lower = value.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (lower === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  throw invalid();
}

/** One comparison `<attribute path> eq <value>`. */
export function parseComparison(text: string, scimType: "invalidFilter" | "invalidPath" = "invalidFilter"): Comparison {
  const invalid = () =>
    new ScimError(400, 'Only filters of the form <attribute> eq <value> are supported, e.g. userName eq "alice@example.com"', scimType);
  if (text.length > MAX_FILTER_LENGTH) throw invalid();
  const match = text.match(/^\s*([A-Za-z][\w:.$-]*)\s+([A-Za-z]{2})\s+([\s\S]+?)\s*$/);
  if (!match || match[2].toLowerCase() !== "eq") throw invalid();
  // A value that is itself a comparison ("a eq "x" and b eq "y"") is not one value.
  const value = parseValue(match[3], invalid);
  return { attribute: stripCoreSchema(match[1]).toLowerCase(), value };
}

/** A PATCH operation's path. */
export function parsePath(raw: unknown): ParsedPath {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ScimError(400, "path must be a non-empty string", "invalidPath");
  }
  const path = stripCoreSchema(raw.trim());
  // Extension attributes (enterprise user and others) are kept whole, so
  // callers can recognise and ignore them.
  if (/^urn:/i.test(path)) return { attribute: path.toLowerCase(), filter: null, subAttribute: null };
  const match = path.match(/^([A-Za-z$][\w$-]*)(?:\[([^\]]+)\])?(?:\.([A-Za-z$][\w$-]*))?$/);
  if (!match) throw new ScimError(400, `Unsupported path: ${raw.slice(0, 100)}`, "invalidPath");
  return {
    attribute: match[1].toLowerCase(),
    filter: match[2] !== undefined ? parseComparison(match[2], "invalidPath") : null,
    subAttribute: match[3] !== undefined ? match[3].toLowerCase() : null,
  };
}

/** A list request's filter, limited to the attributes in `allowed` (lowercased). */
export function parseListFilter(raw: string | null, allowed: readonly string[]): Comparison | null {
  if (raw === null || raw.trim() === "") return null;
  const comparison = parseComparison(raw);
  if (!allowed.includes(comparison.attribute)) {
    throw new ScimError(400, `Filtering is supported on: ${allowed.join(", ")}`, "invalidFilter");
  }
  return comparison;
}
