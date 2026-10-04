/**
 * Backup schedules: validation and next-run computation in IANA time zones,
 * across daylight saving transitions (Europe/Rome, America/New_York) and
 * zones with half- and quarter-hour offsets.
 */
import { describe, expect, it } from 'vitest';
import { nextRunAfter, parseSchedule, parseTimeZone, resolveWallTime } from '@/ee/backups/schedule';
import { describeSchedule } from '@/ee/backups/types';

const at = (iso: string) => new Date(iso);
const next = (schedule: Parameters<typeof nextRunAfter>[0], tz: string, after: string) =>
  nextRunAfter(schedule, tz, at(after)).toISOString();

describe('parseSchedule', () => {
  it('accepts the three kinds and defaults to daily at 03:00', () => {
    expect(parseSchedule(undefined)).toEqual({ kind: 'daily', time: '03:00' });
    expect(parseSchedule({ kind: 'hourly' })).toEqual({ kind: 'hourly', minute: 0 });
    expect(parseSchedule({ kind: 'hourly', minute: 45 })).toEqual({ kind: 'hourly', minute: 45 });
    expect(parseSchedule({ kind: 'daily', time: '23:59' })).toEqual({ kind: 'daily', time: '23:59' });
    expect(parseSchedule({ kind: 'weekly', day: 'Monday', time: '00:00' })).toEqual({ kind: 'weekly', day: 'monday', time: '00:00' });
  });

  it.each([
    [null],
    [{ kind: 'monthly' }],
    [{ kind: 'hourly', minute: 60 }],
    [{ kind: 'hourly', minute: 1.5 }],
    [{ kind: 'daily', time: '24:00' }],
    [{ kind: 'daily', time: '3:00' }],
    [{ kind: 'daily' }],
    [{ kind: 'weekly', day: 'someday', time: '03:00' }],
    [{ kind: 'daily', time: '03:00', day: 'monday' }],
  ])('rejects %j', (input) => {
    expect(() => parseSchedule(input)).toThrow();
  });
});

describe('parseTimeZone', () => {
  it('accepts IANA names and defaults to UTC', () => {
    expect(parseTimeZone(undefined)).toBe('UTC');
    expect(parseTimeZone('Europe/Rome')).toBe('Europe/Rome');
    expect(parseTimeZone(' America/Argentina/Buenos_Aires ')).toBe('America/Argentina/Buenos_Aires');
  });

  it.each(['', 'Mars/Olympus_Mons', 'Europe/ Rome', '../etc/passwd', 42, 'x'.repeat(65)])('rejects %j', (input) => {
    expect(() => parseTimeZone(input)).toThrow(/IANA time zone/);
  });
});

describe('nextRunAfter: daily and weekly', () => {
  it('is strictly after the given instant', () => {
    const schedule = { kind: 'daily', time: '03:00' } as const;
    expect(next(schedule, 'UTC', '2026-10-02T02:59:59.000Z')).toBe('2026-10-02T03:00:00.000Z');
    expect(next(schedule, 'UTC', '2026-10-02T03:00:00.000Z')).toBe('2026-10-03T03:00:00.000Z');
  });

  it('reads the time in the destination time zone', () => {
    const schedule = { kind: 'daily', time: '03:00' } as const;
    expect(next(schedule, 'Europe/Rome', '2026-07-01T12:00:00Z')).toBe('2026-07-02T01:00:00.000Z'); // CEST, UTC+2
    expect(next(schedule, 'Europe/Rome', '2026-12-01T12:00:00Z')).toBe('2026-12-02T02:00:00.000Z'); // CET, UTC+1
    expect(next(schedule, 'America/New_York', '2026-07-01T12:00:00Z')).toBe('2026-07-02T07:00:00.000Z'); // EDT
    expect(next(schedule, 'Asia/Kolkata', '2026-07-01T12:00:00Z')).toBe('2026-07-01T21:30:00.000Z'); // UTC+5:30
    expect(next(schedule, 'Asia/Kathmandu', '2026-07-01T12:00:00Z')).toBe('2026-07-01T21:15:00.000Z'); // UTC+5:45
    // Pacific/Kiritimati is UTC+14: local 03:00 on July 2 is 13:00 UTC on July 1.
    expect(next(schedule, 'Pacific/Kiritimati', '2026-07-01T12:00:00Z')).toBe('2026-07-01T13:00:00.000Z');
  });

  it('keeps the local time across a DST change', () => {
    const schedule = { kind: 'daily', time: '04:00' } as const;
    // Rome switches to CEST on 2026-03-29.
    expect(next(schedule, 'Europe/Rome', '2026-03-28T12:00:00Z')).toBe('2026-03-29T02:00:00.000Z');
    expect(next(schedule, 'Europe/Rome', '2026-03-28T02:00:00Z')).toBe('2026-03-28T03:00:00.000Z');
  });

  it('runs a time inside the spring-forward gap right after the gap, once', () => {
    const schedule = { kind: 'daily', time: '02:30' } as const;
    // 2026-03-29 02:00 CET → 03:00 CEST: 02:30 does not exist and becomes 03:30 CEST (01:30 UTC).
    const first = next(schedule, 'Europe/Rome', '2026-03-28T12:00:00Z');
    expect(first).toBe('2026-03-29T01:30:00.000Z');
    expect(next(schedule, 'Europe/Rome', first)).toBe('2026-03-30T00:30:00.000Z');
    // New York: 2026-03-08 02:00 EST → 03:00 EDT.
    expect(next(schedule, 'America/New_York', '2026-03-08T00:00:00Z')).toBe('2026-03-08T07:30:00.000Z');
  });

  it('runs a repeated time once, at its first occurrence', () => {
    const schedule = { kind: 'daily', time: '02:30' } as const;
    // 2026-10-25 03:00 CEST → 02:00 CET: 02:30 happens at 00:30 and 01:30 UTC.
    const first = next(schedule, 'Europe/Rome', '2026-10-24T12:00:00Z');
    expect(first).toBe('2026-10-25T00:30:00.000Z');
    expect(next(schedule, 'Europe/Rome', first)).toBe('2026-10-26T01:30:00.000Z');
    expect(next(schedule, 'Europe/Rome', '2026-10-25T01:00:00Z')).toBe('2026-10-26T01:30:00.000Z');
  });

  it('finds the next matching weekday', () => {
    const schedule = { kind: 'weekly', day: 'sunday', time: '01:15' } as const;
    // 2026-10-02 is a Friday.
    expect(next(schedule, 'UTC', '2026-10-02T10:00:00Z')).toBe('2026-10-04T01:15:00.000Z');
    expect(next(schedule, 'UTC', '2026-10-04T01:15:00Z')).toBe('2026-10-11T01:15:00.000Z');
    // Sunday 01:15 in Tokyo (UTC+9) is Saturday 16:15 UTC.
    expect(next(schedule, 'Asia/Tokyo', '2026-10-02T10:00:00Z')).toBe('2026-10-03T16:15:00.000Z');
    // Rome's fall-back Sunday.
    expect(next({ kind: 'weekly', day: 'sunday', time: '02:30' }, 'Europe/Rome', '2026-10-20T00:00:00Z')).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('nextRunAfter: hourly', () => {
  it('runs at the given minute of every hour', () => {
    expect(next({ kind: 'hourly', minute: 15 }, 'UTC', '2026-10-02T10:14:00Z')).toBe('2026-10-02T10:15:00.000Z');
    expect(next({ kind: 'hourly', minute: 15 }, 'UTC', '2026-10-02T10:15:00Z')).toBe('2026-10-02T11:15:00.000Z');
    expect(next({ kind: 'hourly', minute: 0 }, 'UTC', '2026-12-31T23:30:00Z')).toBe('2027-01-01T00:00:00.000Z');
  });

  it('uses the local minute in zones with a half-hour offset', () => {
    // Local minute 00 in Kolkata (UTC+5:30) is minute 30 in UTC.
    expect(next({ kind: 'hourly', minute: 0 }, 'Asia/Kolkata', '2026-10-02T10:00:00Z')).toBe('2026-10-02T10:30:00.000Z');
  });

  it('skips the missing hour and runs the repeated hour twice', () => {
    const schedule = { kind: 'hourly', minute: 30 } as const;
    // Spring forward in Rome: 01:30 CET (00:30Z), then 03:30 CEST (01:30Z).
    expect(next(schedule, 'Europe/Rome', '2026-03-29T00:30:00Z')).toBe('2026-03-29T01:30:00.000Z');
    // Fall back: 02:30 CEST (00:30Z), 02:30 CET (01:30Z), 03:30 CET (02:30Z).
    const runs = ['2026-10-24T23:45:00Z'];
    for (let i = 0; i < 3; i++) runs.push(next(schedule, 'Europe/Rome', runs[runs.length - 1]));
    expect(runs.slice(1)).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z', '2026-10-25T02:30:00.000Z']);
  });
});

describe('resolveWallTime', () => {
  it('reports a gap, a normal time and a repeated time', () => {
    const date = { year: 2026, month: 3, day: 29 };
    expect(resolveWallTime('Europe/Rome', date, 2, 30).instants).toEqual([]);
    expect(resolveWallTime('Europe/Rome', date, 4, 0).instants).toEqual([Date.parse('2026-03-29T02:00:00Z')]);
    expect(resolveWallTime('Europe/Rome', { year: 2026, month: 10, day: 25 }, 2, 30).instants).toEqual([
      Date.parse('2026-10-25T00:30:00Z'),
      Date.parse('2026-10-25T01:30:00Z'),
    ]);
  });
});

describe('describeSchedule', () => {
  it('names the schedule and its time zone', () => {
    expect(describeSchedule({ kind: 'hourly', minute: 5 }, 'UTC')).toBe('Hourly at minute 05 (UTC)');
    expect(describeSchedule({ kind: 'daily', time: '03:00' }, 'Europe/Rome')).toBe('Daily at 03:00 (Europe/Rome)');
    expect(describeSchedule({ kind: 'weekly', day: 'monday', time: '22:30' }, 'UTC')).toBe('Mondays at 22:30 (UTC)');
  });
});
