/**
 * Change windows of approval policies (ee/approvals/windows.ts): validation,
 * whether a window is open at an instant (weekdays, past midnight, time
 * zones), daylight saving time on both edges in two time zones, the next
 * opening of several policies' windows together, and the description.
 */
import { describe, expect, it } from 'vitest';
import {
  allWindowsOpenAt,
  describeWindows,
  isWindowOpenAt,
  nextOpening,
  parseWindows,
  readStoredWindows,
} from '@/ee/approvals/windows';
import type { ChangeWindow } from '@/ee/approvals/types';

const WEEKDAYS: ChangeWindow['days'] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const at = (iso: string) => new Date(iso);

describe('parseWindows', () => {
  it('accepts windows and normalizes the days (Monday first, no duplicates)', () => {
    expect(parseWindows([{ days: ['Friday', 'monday', 'monday'], start: '09:00', end: '17:30' }])).toEqual([
      { days: ['monday', 'friday'], start: '09:00', end: '17:30' },
    ]);
    expect(parseWindows([{ days: ['sunday'], start: '00:00', end: '24:00' }])).toEqual([
      { days: ['sunday'], start: '00:00', end: '24:00' },
    ]);
    expect(parseWindows(undefined)).toEqual([]);
    expect(parseWindows(null)).toEqual([]);
  });

  it('refuses malformed windows', () => {
    const bad: unknown[] = [
      'monday 9-5',
      [{ days: [], start: '09:00', end: '17:00' }],
      [{ days: ['someday'], start: '09:00', end: '17:00' }],
      [{ days: ['monday'], start: '9:00', end: '17:00' }],
      [{ days: ['monday'], start: '24:00', end: '17:00' }],
      [{ days: ['monday'], start: '09:00', end: '25:00' }],
      [{ days: ['monday'], start: '09:00', end: '09:00' }],
      [{ days: ['monday'], start: '09:00', end: '17:00', zone: 'UTC' }],
      Array.from({ length: 15 }, () => ({ days: ['monday'], start: '09:00', end: '10:00' })),
    ];
    for (const value of bad) expect(() => parseWindows(value), JSON.stringify(value)).toThrow();
  });

  it('reads stored windows the protective way: unreadable windows never open', () => {
    expect(readStoredWindows('[]')).toEqual([]);
    expect(readStoredWindows(JSON.stringify([{ days: ['monday'], start: '09:00', end: '17:00' }]))).toHaveLength(1);
    const broken = readStoredWindows(JSON.stringify([{ days: ['nope'], start: 'x', end: 'y' }]));
    expect(broken).toHaveLength(1);
    expect(isWindowOpenAt(broken, 'UTC', at('2026-10-05T10:00:00Z'))).toBe(false);
  });
});

describe('isWindowOpenAt', () => {
  const office: ChangeWindow[] = [{ days: WEEKDAYS, start: '09:00', end: '17:00' }];

  it('is always open without windows', () => {
    expect(isWindowOpenAt([], 'Europe/Rome', at('2026-10-04T03:00:00Z'))).toBe(true);
  });

  it('reads the wall clock of the time zone, start included and end excluded', () => {
    // Monday 5 October 2026, Rome is UTC+2 (CEST).
    expect(isWindowOpenAt(office, 'Europe/Rome', at('2026-10-05T07:00:00Z'))).toBe(true); // 09:00
    expect(isWindowOpenAt(office, 'Europe/Rome', at('2026-10-05T06:59:00Z'))).toBe(false); // 08:59
    expect(isWindowOpenAt(office, 'Europe/Rome', at('2026-10-05T14:59:00Z'))).toBe(true); // 16:59
    expect(isWindowOpenAt(office, 'Europe/Rome', at('2026-10-05T15:00:00Z'))).toBe(false); // 17:00
    // The same instant is outside the window in New York (03:00).
    expect(isWindowOpenAt(office, 'America/New_York', at('2026-10-05T07:00:00Z'))).toBe(false);
    // Saturday.
    expect(isWindowOpenAt(office, 'Europe/Rome', at('2026-10-03T10:00:00Z'))).toBe(false);
  });

  it('uses the local weekday, not the UTC one', () => {
    // Monday 00:30 in Rome is still Sunday in UTC.
    const mondayNight: ChangeWindow[] = [{ days: ['monday'], start: '00:00', end: '01:00' }];
    expect(isWindowOpenAt(mondayNight, 'Europe/Rome', at('2026-10-04T22:30:00Z'))).toBe(true);
    expect(isWindowOpenAt(mondayNight, 'UTC', at('2026-10-04T22:30:00Z'))).toBe(false);
  });

  it('runs a window whose end is not after its start past midnight', () => {
    const fridayNight: ChangeWindow[] = [{ days: ['friday'], start: '22:00', end: '02:00' }];
    expect(isWindowOpenAt(fridayNight, 'UTC', at('2026-10-02T22:00:00Z'))).toBe(true); // Fri 22:00
    expect(isWindowOpenAt(fridayNight, 'UTC', at('2026-10-03T01:59:00Z'))).toBe(true); // Sat 01:59
    expect(isWindowOpenAt(fridayNight, 'UTC', at('2026-10-03T02:00:00Z'))).toBe(false); // Sat 02:00
    expect(isWindowOpenAt(fridayNight, 'UTC', at('2026-10-01T23:00:00Z'))).toBe(false); // Thu 23:00
    expect(isWindowOpenAt(fridayNight, 'UTC', at('2026-10-03T22:30:00Z'))).toBe(false); // Sat 22:30
  });

  it('covers a whole day with 00:00 to 24:00', () => {
    const sunday: ChangeWindow[] = [{ days: ['sunday'], start: '00:00', end: '24:00' }];
    expect(isWindowOpenAt(sunday, 'UTC', at('2026-10-04T00:00:00Z'))).toBe(true);
    expect(isWindowOpenAt(sunday, 'UTC', at('2026-10-04T23:59:00Z'))).toBe(true);
    expect(isWindowOpenAt(sunday, 'UTC', at('2026-10-05T00:00:00Z'))).toBe(false);
  });
});

describe('daylight saving time', () => {
  it('never opens a window inside the skipped hour (Rome, spring forward 29 March 2026)', () => {
    const skipped: ChangeWindow[] = [{ days: ['sunday'], start: '02:00', end: '03:00' }];
    // 01:59 CET is 00:59Z; the next minute is 03:00 CEST (01:00Z).
    expect(isWindowOpenAt(skipped, 'Europe/Rome', at('2026-03-29T00:59:00Z'))).toBe(false);
    expect(isWindowOpenAt(skipped, 'Europe/Rome', at('2026-03-29T01:00:00Z'))).toBe(false);
    expect(isWindowOpenAt(skipped, 'Europe/Rome', at('2026-03-29T01:30:00Z'))).toBe(false);
    // So its next opening is a week later: 02:00 CEST on 5 April is 00:00Z.
    expect(nextOpening([{ windows: skipped, timeZone: 'Europe/Rome' }], at('2026-03-28T12:00:00Z'))?.toISOString()).toBe(
      '2026-04-05T00:00:00.000Z'
    );
  });

  it('opens a window overlapping the skipped hour at the first minute that exists', () => {
    const overlapping: ChangeWindow[] = [{ days: ['sunday'], start: '02:30', end: '04:00' }];
    expect(isWindowOpenAt(overlapping, 'Europe/Rome', at('2026-03-29T00:59:00Z'))).toBe(false); // 01:59 CET
    expect(isWindowOpenAt(overlapping, 'Europe/Rome', at('2026-03-29T01:00:00Z'))).toBe(true); // 03:00 CEST
    expect(isWindowOpenAt(overlapping, 'Europe/Rome', at('2026-03-29T01:59:00Z'))).toBe(true); // 03:59 CEST
    expect(isWindowOpenAt(overlapping, 'Europe/Rome', at('2026-03-29T02:00:00Z'))).toBe(false); // 04:00 CEST
    expect(nextOpening([{ windows: overlapping, timeZone: 'Europe/Rome' }], at('2026-03-28T23:00:00Z'))?.toISOString()).toBe(
      '2026-03-29T01:00:00.000Z'
    );
  });

  it('keeps a window in the repeated hour open for both occurrences (Rome, fall back 25 October 2026)', () => {
    const repeated: ChangeWindow[] = [{ days: ['sunday'], start: '02:00', end: '03:00' }];
    expect(isWindowOpenAt(repeated, 'Europe/Rome', at('2026-10-24T23:59:00Z'))).toBe(false); // 01:59 CEST
    expect(isWindowOpenAt(repeated, 'Europe/Rome', at('2026-10-25T00:00:00Z'))).toBe(true); // 02:00 CEST
    expect(isWindowOpenAt(repeated, 'Europe/Rome', at('2026-10-25T00:59:00Z'))).toBe(true); // 02:59 CEST
    expect(isWindowOpenAt(repeated, 'Europe/Rome', at('2026-10-25T01:00:00Z'))).toBe(true); // 02:00 CET
    expect(isWindowOpenAt(repeated, 'Europe/Rome', at('2026-10-25T01:59:00Z'))).toBe(true); // 02:59 CET
    expect(isWindowOpenAt(repeated, 'Europe/Rome', at('2026-10-25T02:00:00Z'))).toBe(false); // 03:00 CET
  });

  it('follows the New York clock on both 2026 transitions', () => {
    const night: ChangeWindow[] = [{ days: ['sunday'], start: '01:30', end: '02:30' }];
    // Spring forward on 8 March at 02:00 EST (07:00Z): 01:30–02:00 exists, 02:00–02:30 does not.
    expect(isWindowOpenAt(night, 'America/New_York', at('2026-03-08T06:30:00Z'))).toBe(true); // 01:30 EST
    expect(isWindowOpenAt(night, 'America/New_York', at('2026-03-08T06:59:00Z'))).toBe(true); // 01:59 EST
    expect(isWindowOpenAt(night, 'America/New_York', at('2026-03-08T07:00:00Z'))).toBe(false); // 03:00 EDT
    // Fall back on 1 November at 02:00 EDT (06:00Z): 01:30–02:00 happens twice.
    expect(isWindowOpenAt(night, 'America/New_York', at('2026-11-01T05:30:00Z'))).toBe(true); // 01:30 EDT
    expect(isWindowOpenAt(night, 'America/New_York', at('2026-11-01T06:30:00Z'))).toBe(true); // 01:30 EST
    expect(isWindowOpenAt(night, 'America/New_York', at('2026-11-01T07:15:00Z'))).toBe(true); // 02:15 EST
    expect(isWindowOpenAt(night, 'America/New_York', at('2026-11-01T07:30:00Z'))).toBe(false); // 02:30 EST
  });
});

describe('nextOpening', () => {
  const rome = { windows: [{ days: WEEKDAYS, start: '09:00', end: '17:00' }], timeZone: 'Europe/Rome' };

  it('is now when every window is open, and the next start otherwise', () => {
    const now = at('2026-10-05T08:00:00Z'); // Monday 10:00 in Rome
    expect(nextOpening([rome], now)?.toISOString()).toBe(now.toISOString());
    // Friday 18:00 in Rome: next opening is Monday 09:00 CEST.
    expect(nextOpening([rome], at('2026-10-09T16:00:00Z'))?.toISOString()).toBe('2026-10-12T07:00:00.000Z');
    // Unrestricted rules never wait.
    expect(nextOpening([{ windows: [], timeZone: 'UTC' }], now)?.toISOString()).toBe(now.toISOString());
  });

  it('finds when the windows of several policies overlap, or that they never do', () => {
    const utcAfternoon = { windows: [{ days: WEEKDAYS, start: '14:00', end: '20:00' }], timeZone: 'UTC' };
    // Rome 09:00–17:00 CEST is 07:00–15:00Z: they overlap 14:00–15:00Z.
    const next = nextOpening([rome, utcAfternoon], at('2026-10-05T05:00:00Z'));
    expect(next?.toISOString()).toBe('2026-10-05T14:00:00.000Z');
    expect(allWindowsOpenAt([rome, utcAfternoon], at('2026-10-05T14:30:00Z'))).toBe(true);
    expect(allWindowsOpenAt([rome, utcAfternoon], at('2026-10-05T15:30:00Z'))).toBe(false);

    const utcEvening = { windows: [{ days: WEEKDAYS, start: '16:00', end: '20:00' }], timeZone: 'UTC' };
    expect(nextOpening([rome, utcEvening], at('2026-10-05T05:00:00Z'))).toBeNull();
  });
});

describe('describeWindows', () => {
  it('names day ranges and the time zone', () => {
    expect(describeWindows([], 'UTC')).toBeNull();
    expect(
      describeWindows(
        [
          { days: WEEKDAYS, start: '09:00', end: '17:00' },
          { days: ['saturday', 'monday'], start: '22:00', end: '02:00' },
        ],
        'Europe/Rome'
      )
    ).toBe('Mon–Fri 09:00–17:00, Mon, Sat 22:00–02:00 (Europe/Rome)');
  });
});
