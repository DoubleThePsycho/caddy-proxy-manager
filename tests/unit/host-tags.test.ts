import { describe, expect, it } from 'vitest';
import { MAX_TAGS_PER_HOST, normalizeTags, parseStoredTags, serializeTags } from '@/src/lib/host-tags';
import { ApiValidationError } from '@/src/lib/api-errors';

describe('host tags', () => {
  it('lowercases, trims, deduplicates and sorts', () => {
    expect(normalizeTags([' Team-A ', 'prod', 'team-a', ''])).toEqual(['prod', 'team-a']);
    expect(normalizeTags('eu/west, Team:A ,')).toEqual(['eu/west', 'team:a']);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it.each([
    [['has space']],
    [['-leading']],
    [['a'.repeat(41)]],
    [['emoji🙂']],
    [[1]],
    [{ tag: 'x' }],
  ])('refuses %j', (input) => {
    expect(() => normalizeTags(input)).toThrow(ApiValidationError);
  });

  it(`allows at most ${MAX_TAGS_PER_HOST} tags`, () => {
    const tags = Array.from({ length: MAX_TAGS_PER_HOST + 1 }, (_, index) => `t${index}`);
    expect(() => normalizeTags(tags)).toThrow(/at most/);
    expect(normalizeTags(tags.slice(1))).toHaveLength(MAX_TAGS_PER_HOST);
  });

  it('reads stored tags leniently', () => {
    expect(parseStoredTags(serializeTags(['a', 'b']))).toEqual(['a', 'b']);
    expect(parseStoredTags('not json')).toEqual([]);
    expect(parseStoredTags('{"a":1}')).toEqual([]);
    expect(parseStoredTags('["ok", 3, "BAD TAG"]')).toEqual(['ok']);
    expect(parseStoredTags(null)).toEqual([]);
  });
});
