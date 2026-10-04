/**
 * Line diffs for DiffView: a longest-common-subsequence diff of two lists of
 * lines, a diff of two JSON values (pretty-printed with sorted keys, so key
 * order never shows as a change), and the helpers DiffView renders with
 * (folding long unchanged runs, pairing lines side by side). Pure functions,
 * safe on the server and the client.
 */

export type DiffLineType = "add" | "remove" | "context";

export type DiffLine = {
  type: DiffLineType;
  text: string;
  /** Line number in the old text (removed and unchanged lines). */
  oldNumber?: number;
  /** Line number in the new text (added and unchanged lines). */
  newNumber?: number;
};

/** Above this many cells the LCS table would be too large; the changed middle is shown as removed then added. */
const MAX_LCS_CELLS = 4_000_000;

/**
 * The diff of `a` (old) to `b` (new), line by line: unchanged lines as
 * context, the rest as removals and additions (removals first within a
 * change). Common leading and trailing lines are matched first, so large
 * texts with a small change stay cheap.
 */
export function diffLines(a: readonly string[], b: readonly string[]): DiffLine[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: "context", text: a[i], oldNumber: i + 1, newNumber: i + 1 });

  const n = endA - start;
  const m = endB - start;
  if (n > 0 || m > 0) {
    if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) {
      for (let i = start; i < endA; i++) out.push({ type: "remove", text: a[i], oldNumber: i + 1 });
      for (let j = start; j < endB; j++) out.push({ type: "add", text: b[j], newNumber: j + 1 });
    } else {
      // lengths[i][j]: LCS length of a[start+i..endA) and b[start+j..endB).
      const width = m + 1;
      const lengths = new Uint32Array((n + 1) * width);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          lengths[i * width + j] =
            a[start + i] === b[start + j]
              ? lengths[(i + 1) * width + j + 1] + 1
              : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      const removed: DiffLine[] = [];
      const added: DiffLine[] = [];
      const flush = () => {
        out.push(...removed, ...added);
        removed.length = 0;
        added.length = 0;
      };
      while (i < n || j < m) {
        if (i < n && j < m && a[start + i] === b[start + j]) {
          flush();
          out.push({ type: "context", text: a[start + i], oldNumber: start + i + 1, newNumber: start + j + 1 });
          i++;
          j++;
        } else if (j >= m || (i < n && lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
          removed.push({ type: "remove", text: a[start + i], oldNumber: start + i + 1 });
          i++;
        } else {
          added.push({ type: "add", text: b[start + j], newNumber: start + j + 1 });
          j++;
        }
      }
      flush();
    }
  }

  for (let k = 0; endA + k < a.length; k++) {
    out.push({ type: "context", text: a[endA + k], oldNumber: endA + k + 1, newNumber: endB + k + 1 });
  }
  return out;
}

function sortKeys(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const result = value.map((item) => (item === undefined ? null : sortKeys(item, seen)));
    seen.delete(value);
    return result;
  }
  if (value !== null && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = sortKeys(item, seen);
    }
    seen.delete(value);
    return result;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * A JSON value as lines: pretty-printed with two spaces and object keys
 * sorted at every level. `undefined` (no value at all) is no lines.
 */
export function stableJsonLines(value: unknown): string[] {
  if (value === undefined) return [];
  const text = JSON.stringify(sortKeys(value, new WeakSet()), null, 2);
  return text === undefined ? [] : text.split("\n");
}

/** The line diff of two JSON values; key order does not matter. */
export function diffJson(before: unknown, after: unknown): DiffLine[] {
  return diffLines(stableJsonLines(before), stableJsonLines(after));
}

/** Whether the diff has any addition or removal. */
export function hasChanges(lines: readonly DiffLine[]): boolean {
  return lines.some((line) => line.type !== "context");
}

export type DiffSegment =
  | { kind: "lines"; lines: DiffLine[] }
  /** A folded run of unchanged lines; `id` is stable for the same input. */
  | { kind: "gap"; id: string; lines: DiffLine[] };

/**
 * Splits a diff into what to show and what to fold: unchanged runs keep
 * `context` lines next to each change, and a run is folded only when that
 * hides at least `minHidden` lines (so "1 unchanged line" never appears).
 * Gaps whose id is in `expanded` stay open.
 */
export function foldContext(
  lines: readonly DiffLine[],
  options: { context?: number; minHidden?: number; expanded?: ReadonlySet<string> } = {}
): DiffSegment[] {
  const context = Math.max(0, options.context ?? 3);
  const minHidden = Math.max(1, options.minHidden ?? 4);
  const expanded = options.expanded ?? new Set<string>();
  const segments: DiffSegment[] = [];
  let shown: DiffLine[] = [];
  const pushShown = (items: DiffLine[]) => {
    shown.push(...items);
  };
  const flushShown = () => {
    if (shown.length > 0) segments.push({ kind: "lines", lines: shown });
    shown = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "context") {
      pushShown([lines[i]]);
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].type === "context") end++;
    const run = lines.slice(i, end);
    const atStart = i === 0;
    const atEnd = end === lines.length;
    const keepBefore = atStart ? 0 : context;
    const keepAfter = atEnd ? 0 : context;
    const hidden = run.length - keepBefore - keepAfter;
    const id = `${run[0].oldNumber ?? 0}-${run[run.length - 1].oldNumber ?? 0}`;
    if (hidden >= minHidden && !expanded.has(id)) {
      pushShown(run.slice(0, keepBefore));
      flushShown();
      segments.push({ kind: "gap", id, lines: run.slice(keepBefore, run.length - keepAfter) });
      pushShown(run.slice(run.length - keepAfter));
    } else {
      pushShown(run);
    }
    i = end;
  }
  flushShown();
  return segments;
}

export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

/**
 * Pairs lines for a side-by-side view: unchanged lines on both sides, and
 * each block of removals next to the additions that follow it.
 */
export function toSplitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "remove") removed.push(lines[i++]);
    while (i < lines.length && lines[i].type === "add") added.push(lines[i++]);
    const count = Math.max(removed.length, added.length);
    for (let k = 0; k < count; k++) rows.push({ left: removed[k] ?? null, right: added[k] ?? null });
  }
  return rows;
}
