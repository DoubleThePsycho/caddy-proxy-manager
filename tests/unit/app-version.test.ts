/**
 * How versions are shown: "v" only for releases (semver), a commit build as
 * its short hash ("build 18b823e" after the product name).
 */
import { describe, expect, it } from 'vitest';
import { formatAppVersion, formatVersion, isReleaseVersion } from '@/src/lib/app-version';

describe('isReleaseVersion', () => {
  it.each(['2.0.0', 'v2.0.0', '1.14.2-rc.1', '2.1.0+build.5', '10.20.30'])('treats %s as a release', (version) => {
    expect(isReleaseVersion(version)).toBe(true);
  });

  it.each(['18b823e', '1234567', 'unknown', '', '2.0', 'v2', 'main', '2.0.0 beta'])('does not treat %s as a release', (version) => {
    expect(isReleaseVersion(version)).toBe(false);
  });
});

describe('formatVersion', () => {
  it('prefixes releases with one "v"', () => {
    expect(formatVersion('2.0.0')).toBe('v2.0.0');
    expect(formatVersion('v2.0.0')).toBe('v2.0.0');
    expect(formatVersion('1.14.2-rc.1')).toBe('v1.14.2-rc.1');
  });

  it('shows a commit build as its short hash, without "v"', () => {
    expect(formatVersion('18b823e')).toBe('18b823e');
    expect(formatVersion('18B823E4F0C1D2E3F4A5B6C7D8E9F0A1B2C3D4E5')).toBe('18b823e');
    expect(formatVersion('1234567')).toBe('1234567');
  });

  it('leaves anything else as it is', () => {
    expect(formatVersion('unknown')).toBe('unknown');
    expect(formatVersion('dev')).toBe('dev');
  });
});

describe('formatAppVersion', () => {
  it('reads after the product name', () => {
    expect(formatAppVersion('2.0.0')).toBe('v2.0.0');
    expect(formatAppVersion('18b823e')).toBe('build 18b823e');
    expect(formatAppVersion('unknown')).toBe('version unknown');
    expect(formatAppVersion('')).toBe('version unknown');
  });
});
