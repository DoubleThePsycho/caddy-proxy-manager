// SPDX-License-Identifier: Elastic-2.0
/**
 * What a change request changes, field by field, for the approvers: the
 * requested values against the host as it was when the change was
 * requested. Like configuration history diffs (ee/config-history/diff.ts),
 * values are compared as canonical JSON and fields whose name marks them as
 * secret only report that they change.
 *
 * Inputs are partial: a field (or a key of a nested object) that the change
 * does not set is left as it is and not listed.
 */
import { canonicalJson } from "@/ee/config-history/fingerprint";
import type { ChangeField } from "./types";

const SENSITIVE_NAME = /passw(or)?d|passphrase|secret|token|private_?key|api_?key|credential|cookie/i;
const MAX_FIELDS = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastSegment(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1] ?? path;
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/** Values that all mean "not set" (a form sends false or [] where the host stores nothing). */
function isUnset(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.values(value).every(isUnset);
}

function walk(before: unknown, after: unknown, path: string, out: ChangeField[], partial: boolean): void {
  if (out.length >= MAX_FIELDS) return;
  if (isRecord(after) && (isRecord(before) || before == null)) {
    const a = isRecord(before) ? before : {};
    // A partial input only names the keys it changes; a new object lists all of its keys.
    const keys = partial && isRecord(before) ? Object.keys(after) : [...new Set([...Object.keys(a), ...Object.keys(after)])];
    for (const key of keys.sort()) {
      if (partial && after[key] === undefined) continue;
      walk(a[key], after[key], path ? `${path}.${key}` : key, out, partial);
    }
    return;
  }
  if (isRecord(before) && after == null && !partial) {
    for (const key of Object.keys(before).sort()) walk(before[key], undefined, path ? `${path}.${key}` : key, out, partial);
    return;
  }
  if (same(before, after) || (partial && isUnset(before) && isUnset(after))) return;
  if (SENSITIVE_NAME.test(lastSegment(path))) {
    out.push({ path, secret: true });
    return;
  }
  out.push({ path, before: before === undefined ? null : before, after: after === undefined ? null : after });
}

/** The fields `input` (partial) changes on `current`. */
export function diffPartial(current: unknown, input: unknown, path = ""): ChangeField[] {
  const out: ChangeField[] = [];
  walk(current, input, path, out, true);
  return out;
}

/** Every field of a value that appears (before null) or disappears (after null). */
export function diffWhole(before: unknown, after: unknown, path = ""): ChangeField[] {
  const out: ChangeField[] = [];
  walk(before, after, path, out, false);
  return out;
}
