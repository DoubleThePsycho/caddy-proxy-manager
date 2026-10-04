import { describe, expect, it } from 'vitest';
import {
  DIGEST_CATCH_UP_MS,
  addDays,
  digestSchedule,
  isValidTimeOfDay,
  isValidTimeZone,
  localDate,
  zonedTimeToUtc,
} from '@/ee/ai/digest-schedule';

describe('digest schedule helpers', () => {
  it('validates times of day and IANA time zones', () => {
    expect(isValidTimeOfDay('08:00')).toBe(true);
    expect(isValidTimeOfDay('23:59')).toBe(true);
    expect(isValidTimeOfDay('24:00')).toBe(false);
    expect(isValidTimeOfDay('8:00')).toBe(false);
    expect(isValidTimeZone('Europe/Rome')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('Europe/Rome; rm -rf')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('converts a wall-clock time in a time zone to UTC, across daylight saving time', () => {
    expect(zonedTimeToUtc('2026-07-01', '08:00', 'Europe/Rome').toISOString()).toBe('2026-07-01T06:00:00.000Z');
    expect(zonedTimeToUtc('2026-12-01', '08:00', 'Europe/Rome').toISOString()).toBe('2026-12-01T07:00:00.000Z');
    expect(zonedTimeToUtc('2026-07-01', '08:00', 'America/New_York').toISOString()).toBe('2026-07-01T12:00:00.000Z');
    expect(zonedTimeToUtc('2026-07-01', '08:00', 'UTC').toISOString()).toBe('2026-07-01T08:00:00.000Z');
    // 02:30 does not exist on 2026-03-29 in Rome: the result is just after the gap.
    const gap = zonedTimeToUtc('2026-03-29', '02:30', 'Europe/Rome');
    expect(gap.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-03-29T01:00:00.000Z'));
    expect(localDate(gap, 'Europe/Rome')).toBe('2026-03-29');
  });

  it('computes local dates and adds days', () => {
    expect(localDate(new Date('2026-10-01T23:30:00.000Z'), 'Europe/Rome')).toBe('2026-10-02');
    expect(localDate(new Date('2026-10-01T23:30:00.000Z'), 'UTC')).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('digestSchedule', () => {
  const base = { timeOfDay: '08:00', timeZone: 'Europe/Rome', lastRunDate: null, activeSince: '2026-09-01T00:00:00.000Z' };

  it('is due once the local time has passed, once per local day', () => {
    const before = digestSchedule(base, new Date('2026-10-02T05:59:00.000Z'));
    expect(before.due).toBe(false);
    expect(before.nextRunAt.toISOString()).toBe('2026-10-02T06:00:00.000Z');

    const at = digestSchedule(base, new Date('2026-10-02T06:00:30.000Z'));
    expect(at).toMatchObject({ due: true, localDate: '2026-10-02' });

    const sent = digestSchedule({ ...base, lastRunDate: '2026-10-02' }, new Date('2026-10-02T06:01:30.000Z'));
    expect(sent.due).toBe(false);
    expect(sent.nextRunAt.toISOString()).toBe('2026-10-03T06:00:00.000Z');
  });

  it('skips a slot missed by more than the catch-up window', () => {
    const late = new Date(Date.parse('2026-10-02T06:00:00.000Z') + DIGEST_CATCH_UP_MS + 60_000);
    const result = digestSchedule(base, late);
    expect(result.due).toBe(false);
    expect(result.nextRunAt.toISOString()).toBe('2026-10-03T06:00:00.000Z');
  });

  it('never sends a slot that passed before the schedule was set', () => {
    const result = digestSchedule({ ...base, activeSince: '2026-10-02T06:30:00.000Z' }, new Date('2026-10-02T06:31:00.000Z'));
    expect(result.due).toBe(false);
    expect(result.nextRunAt.toISOString()).toBe('2026-10-03T06:00:00.000Z');
  });
});
