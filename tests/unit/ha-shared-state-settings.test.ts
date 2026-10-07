/**
 * The shared state switch (ee/high-availability/shared-state/settings.ts):
 * input validation, the generation that changes each time shared state is
 * turned on, stored values that are not valid, and the Lua scripts'
 * portability rules.
 */
import { describe, expect, it } from 'vitest';
import {
  newGeneration,
  parseSharedStateInput,
  parseStoredSharedState,
  sharedStateNamespace,
} from '@/ee/high-availability/shared-state/settings';
import * as scripts from '@/ee/high-availability/shared-state/scripts';
import { parseCreditEntry } from '@/ee/high-availability/shared-state/monetization-drain';

describe('parseSharedStateInput', () => {
  it('turns on with the default prefix and a new generation', () => {
    const next = parseSharedStateInput({}, null);
    expect(next).toMatchObject({ enabled: true, keyPrefix: 'ingressi' });
    expect(next.generation).toMatch(/^[a-f0-9]{12}$/);
  });

  it('keeps the generation while nothing that matters changes, and starts a new one when turned on again or moved', () => {
    const on = parseSharedStateInput({ enabled: true, keyPrefix: 'eu' }, null);
    expect(parseSharedStateInput({ enabled: true }, on).generation).toBe(on.generation);
    const off = parseSharedStateInput({ enabled: false }, on);
    expect(off).toMatchObject({ enabled: false, keyPrefix: 'eu', generation: on.generation });
    expect(parseSharedStateInput({ enabled: true }, off).generation).not.toBe(on.generation);
    expect(parseSharedStateInput({ keyPrefix: 'us' }, on).generation).not.toBe(on.generation);
  });

  it('refuses unknown fields, wrong types and prefixes with other characters', () => {
    expect(() => parseSharedStateInput({ enabled: 'yes' }, null)).toThrow(/enabled/);
    expect(() => parseSharedStateInput({ other: 1 }, null)).toThrow(/Unknown field/);
    for (const keyPrefix of ['a b', 'a:b', '{a}', '-a', 'a/b', 'x'.repeat(101)]) {
      expect(() => parseSharedStateInput({ keyPrefix }, null), keyPrefix).toThrow();
    }
    expect(() => parseSharedStateInput('on', null)).toThrow(/JSON object/);
  });
});

describe('stored values', () => {
  it('reads a valid value and ignores anything else (shared state off)', () => {
    const value = { enabled: true, keyPrefix: 'ingressi', generation: newGeneration() };
    expect(parseStoredSharedState(value)).toEqual(value);
    expect(parseStoredSharedState({ ...value, generation: 'NOT-HEX' })).toBeNull();
    expect(parseStoredSharedState({ ...value, keyPrefix: 'a b' })).toBeNull();
    expect(parseStoredSharedState({ ...value, enabled: 'true' })).toBeNull();
    expect(parseStoredSharedState(null)).toBeNull();
  });

  it('builds the namespace every key starts with', () => {
    expect(sharedStateNamespace({ keyPrefix: 'ingressi', generation: '0123abcd' })).toBe('ingressi:0123abcd:');
  });
});

describe('Lua scripts', () => {
  const all = Object.values(scripts).filter((value): value is scripts.SharedScript => typeof value === 'object' && value !== null && 'lua' in value);

  it('never format numbers with tostring (Lua 5.1 prints large ones in exponent notation)', () => {
    expect(all.length).toBeGreaterThanOrEqual(9);
    for (const script of all) expect(script.lua, script.name).not.toMatch(/tostring\(/);
  });

  it('identify themselves by the SHA-1 of their body', async () => {
    const { createHash } = await import('node:crypto');
    for (const script of all) expect(script.sha).toBe(createHash('sha1').update(script.lua).digest('hex'));
  });
});

describe('queued credits', () => {
  it('reads only well-formed entries', () => {
    const entry = { id: '7d3c1f2e-aaaa-bbbb-cccc-000000000001', ref: 'stripe:cs_1', type: 'topup', amount: 5_000, desc: null, by: null, at: '2026-10-03T12:00:00.000Z' };
    expect(parseCreditEntry(JSON.stringify(entry))).toEqual(entry);
    expect(parseCreditEntry('not json')).toBeNull();
    expect(parseCreditEntry(JSON.stringify({ ...entry, amount: 1.5 }))).toBeNull();
    expect(parseCreditEntry(JSON.stringify({ ...entry, amount: 0 }))).toBeNull();
    expect(parseCreditEntry(JSON.stringify({ ...entry, type: 'usage' }))).toBeNull();
    expect(parseCreditEntry(JSON.stringify({ ...entry, id: 'x' }))).toBeNull();
  });
});
