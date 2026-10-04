/**
 * The overview's date and text helpers (app/(dashboard)/_overview/format.ts):
 * the viewer's time zone, today and yesterday, chart buckets and audit
 * summaries after a name.
 */
import { describe, expect, it } from 'vitest';
import {
  bucketLabel,
  changeTimeLabel,
  headerDateLine,
  initials,
  lowerFirst,
  momentLabel,
  relativeLabel,
} from '@/app/(dashboard)/_overview/format';

const NOW = Date.parse('2026-10-03T11:36:00.000Z');

describe('overview format', () => {
  it('writes the header date in the viewer’s time zone', () => {
    expect(headerDateLine(NOW, 'UTC')).toBe('Saturday 3 October · 11:36 UTC');
    expect(headerDateLine(NOW, 'Europe/Rome')).toBe('Saturday 3 October · 13:36 CEST');
    expect(headerDateLine(Date.parse('2026-10-03T23:30:00.000Z'), 'Europe/Rome')).toBe('Sunday 4 October · 01:30 CEST');
    expect(headerDateLine(NOW, 'Not/AZone')).toBe('Saturday 3 October · 11:36 UTC');
  });

  it('says when a change happened: today, yesterday, this year, earlier', () => {
    expect(changeTimeLabel('2026-10-03T10:58:00.000Z', NOW, 'UTC')).toBe('10:58');
    expect(changeTimeLabel('2026-10-02T18:22:00.000Z', NOW, 'UTC')).toBe('Yesterday 18:22');
    expect(changeTimeLabel('2026-08-20T08:05:00.000Z', NOW, 'UTC')).toBe('20 Aug 08:05');
    expect(changeTimeLabel('2025-12-31T23:00:00.000Z', NOW, 'UTC')).toBe('31 Dec 2025');
    // 23:30 UTC on the 2nd is already the 3rd in Rome.
    expect(changeTimeLabel('2026-10-02T23:30:00.000Z', NOW, 'Europe/Rome')).toBe('01:30');
  });

  it('labels chart buckets by their width', () => {
    const ms = Date.parse('2026-10-03T06:00:00.000Z');
    expect(bucketLabel(ms, 1800, false, 'UTC')).toBe('06:00');
    expect(bucketLabel(ms, 10_800, false, 'UTC')).toBe('Sat 06:00');
    expect(bucketLabel(ms, 86_400, false, 'UTC')).toBe('3 Oct');
    expect(bucketLabel(ms, 1800, true, 'UTC')).toBe('Sat 3 Oct, 06:00 UTC');
    expect(momentLabel(ms, 60, 'UTC')).toBe('06:00');
    expect(momentLabel(ms, 10_800, 'UTC')).toBe('Sat 06:00');
  });

  it('says how long ago, and puts audit summaries after a name', () => {
    expect(relativeLabel('2026-10-03T11:35:50.000Z', NOW)).toBe('just now');
    expect(relativeLabel('2026-10-03T11:31:00.000Z', NOW)).toBe('5 minutes ago');
    expect(relativeLabel('2026-10-03T09:36:00.000Z', NOW)).toBe('2 hours ago');
    expect(relativeLabel('2026-10-02T11:36:00.000Z', NOW)).toBe('1 day ago');
    expect(lowerFirst('Created proxy host wiki')).toBe('created proxy host wiki');
    expect(lowerFirst('DNS provider saved')).toBe('DNS provider saved');
    expect(initials('l.bianchi')).toBe('LB');
    expect(initials('admin')).toBe('AD');
  });
});
