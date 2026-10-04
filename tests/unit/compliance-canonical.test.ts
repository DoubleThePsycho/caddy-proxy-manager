/**
 * Canonical JSON (RFC 8785) and SHA-256 of compliance reports: the same data
 * always gives the same text and hash, whatever the key order.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@/ee/compliance/canonical';

describe('canonicalJson', () => {
  it('sorts keys at every level and leaves no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  });

  it('is independent of key insertion order', () => {
    const one = { type: 'access_review', summary: [{ key: 'users', value: 3 }], period: { from: 'a', to: 'b' } };
    const two = { period: { to: 'b', from: 'a' }, summary: [{ value: 3, key: 'users' }], type: 'access_review' };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
    expect(sha256Hex(canonicalJson(one))).toBe(sha256Hex(canonicalJson(two)));
  });

  it('keeps array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('serializes strings and numbers as RFC 8785 does', () => {
    // Examples from RFC 8785, section 3.2.2.
    expect(canonicalJson({ numbers: [333333333.3333333, 1e30, 4.5, 0.002, 0.000001, 1e-7] })).toBe(
      '{"numbers":[333333333.3333333,1e+30,4.5,0.002,0.000001,1e-7]}'
    );
    expect(canonicalJson('€$\u000f\nA\'B"\\\\"/')).toBe('"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"');
    // Keys sort by UTF-16 code units.
    expect(canonicalJson({ '\u20ac': 1, '\r': 2, '\ufb33': 3, '1': 4, '\ud83d\ude00': 5, '\u0080': 6, '\u00f6': 7 })).toBe(
      '{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}'
    );
  });

  it('drops undefined members and refuses values JSON cannot hold', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Infinity })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });

  it('hashes the UTF-8 bytes with SHA-256', () => {
    const text = canonicalJson({ name: 'Città' });
    expect(sha256Hex(text)).toBe(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));
    expect(sha256Hex(text)).toMatch(/^[0-9a-f]{64}$/);
  });
});
