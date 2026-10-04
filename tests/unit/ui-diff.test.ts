/**
 * The pure diff helpers behind DiffView (src/components/ui/diff.ts): the
 * LCS line diff, JSON diffs that ignore key order, folding unchanged runs
 * and pairing lines side by side.
 */
import { describe, expect, it } from 'vitest';
import { diffJson, diffLines, foldContext, hasChanges, stableJsonLines, toSplitRows, type DiffLine } from '@/components/ui/diff';

/** The diff as "+x", "-x" and " x" strings, easy to compare. */
function compact(lines: DiffLine[]): string[] {
  return lines.map((line) => `${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.text}`);
}

/** Applying the diff to the old text gives the new text; dropping additions gives the old text. */
function sides(lines: DiffLine[]): { before: string[]; after: string[] } {
  return {
    before: lines.filter((line) => line.type !== 'add').map((line) => line.text),
    after: lines.filter((line) => line.type !== 'remove').map((line) => line.text),
  };
}

describe('diffLines', () => {
  it('reports identical input as context only', () => {
    const lines = diffLines(['a', 'b'], ['a', 'b']);
    expect(compact(lines)).toEqual([' a', ' b']);
    expect(hasChanges(lines)).toBe(false);
    expect(lines.map((line) => [line.oldNumber, line.newNumber])).toEqual([[1, 1], [2, 2]]);
  });

  it('finds additions and removals with the longest common subsequence', () => {
    expect(compact(diffLines(['a', 'b', 'c'], ['a', 'c']))).toEqual([' a', '-b', ' c']);
    expect(compact(diffLines(['a', 'c'], ['a', 'b', 'c']))).toEqual([' a', '+b', ' c']);
    expect(compact(diffLines(['a', 'b', 'c'], ['a', 'x', 'c']))).toEqual([' a', '-b', '+x', ' c']);
    expect(compact(diffLines([], ['x', 'y']))).toEqual(['+x', '+y']);
    expect(compact(diffLines(['x', 'y'], []))).toEqual(['-x', '-y']);
  });

  it('keeps the common subsequence maximal', () => {
    const a = ['a', 'b', 'c', 'a', 'b', 'b', 'a'];
    const b = ['c', 'b', 'a', 'b', 'a', 'c'];
    const lines = diffLines(a, b);
    // The LCS of these two classic sequences has length 4.
    expect(lines.filter((line) => line.type === 'context')).toHaveLength(4);
    expect(sides(lines)).toEqual({ before: a, after: b });
  });

  it('numbers lines on each side', () => {
    const lines = diffLines(['a', 'b', 'c'], ['a', 'x', 'y', 'c']);
    expect(lines).toEqual([
      { type: 'context', text: 'a', oldNumber: 1, newNumber: 1 },
      { type: 'remove', text: 'b', oldNumber: 2 },
      { type: 'add', text: 'x', newNumber: 2 },
      { type: 'add', text: 'y', newNumber: 3 },
      { type: 'context', text: 'c', oldNumber: 3, newNumber: 4 },
    ]);
  });

  it('round-trips random edits', () => {
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let run = 0; run < 50; run++) {
      const a = Array.from({ length: Math.floor(random() * 12) }, () => String.fromCharCode(97 + Math.floor(random() * 4)));
      const b = Array.from({ length: Math.floor(random() * 12) }, () => String.fromCharCode(97 + Math.floor(random() * 4)));
      expect(sides(diffLines(a, b))).toEqual({ before: a, after: b });
    }
  });
});

describe('diffJson', () => {
  it('ignores key order at every level', () => {
    const before = { b: 1, a: { y: [1, 2], x: 'same' } };
    const after = { a: { x: 'same', y: [1, 2] }, b: 1 };
    expect(hasChanges(diffJson(before, after))).toBe(false);
    expect(stableJsonLines(before)).toEqual(stableJsonLines(after));
  });

  it('shows a nested change as one removed and one added line', () => {
    const lines = diffJson({ host: { upstreams: ['10.0.0.1:80'], waf: false } }, { host: { waf: true, upstreams: ['10.0.0.1:80'] } });
    expect(compact(lines).filter((line) => !line.startsWith(' '))).toEqual(['-    "waf": false', '+    "waf": true']);
  });

  it('treats a missing value as no lines', () => {
    expect(stableJsonLines(undefined)).toEqual([]);
    const lines = diffJson(undefined, { a: 1 });
    expect(lines.every((line) => line.type === 'add')).toBe(true);
  });

  it('drops undefined properties like JSON does', () => {
    expect(hasChanges(diffJson({ a: 1, b: undefined }, { a: 1 }))).toBe(false);
  });
});

describe('foldContext', () => {
  const lines = diffLines(
    Array.from({ length: 20 }, (_, i) => `line ${i + 1}`),
    Array.from({ length: 20 }, (_, i) => (i === 9 ? 'changed' : `line ${i + 1}`))
  );

  it('folds long unchanged runs and keeps context around the change', () => {
    const segments = foldContext(lines, { context: 2 });
    expect(segments.map((segment) => segment.kind)).toEqual(['gap', 'lines', 'gap']);
    const [first, middle, last] = segments;
    expect(first.lines).toHaveLength(7);
    expect(compact(middle.lines)).toEqual([' line 8', ' line 9', '-line 10', '+changed', ' line 11', ' line 12']);
    expect(last.lines).toHaveLength(8);
  });

  it('leaves short runs and expanded gaps open', () => {
    const segments = foldContext(lines, { context: 2 });
    const gap = segments[0];
    if (gap.kind !== 'gap') throw new Error('expected a gap');
    const reopened = foldContext(lines, { context: 2, expanded: new Set([gap.id]) });
    expect(reopened.map((segment) => segment.kind)).toEqual(['lines', 'gap']);
    expect(foldContext(lines, { context: 2, minHidden: 50 }).map((segment) => segment.kind)).toEqual(['lines']);
  });
});

describe('toSplitRows', () => {
  it('pairs removals with the additions after them', () => {
    const rows = toSplitRows(diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'd', 'e']));
    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'x'],
      ['c', null],
      ['d', 'd'],
      [null, 'e'],
    ]);
  });
});
