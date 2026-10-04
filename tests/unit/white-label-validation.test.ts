/**
 * White-label input validation and colours (ee/white-label/validation.ts,
 * colors.ts): strict hex colours with enough contrast, plain-text fields,
 * safe URLs, and CSS that only ever carries validated colours.
 */
import { describe, expect, it } from 'vitest';
import {
  accentContrastProblem,
  accentCss,
  accentPalette,
  contrastRatio,
  DARK_SURFACE,
  deriveDarkAccent,
  foregroundFor,
  LIGHT_SURFACE,
  MIN_ACCENT_CONTRAST,
  MIN_TEXT_CONTRAST,
  normalizeHexColor,
  readableAccent,
} from '@/ee/white-label/colors';
import { fieldsNeedingLicense, normalizeStoredSettings, parseBrandingInput } from '@/ee/white-label/validation';
import { DEFAULT_BRANDING_SETTINGS } from '@/ee/white-label/types';

describe('colours', () => {
  it('accepts only #rgb and #rrggbb and normalises them', () => {
    expect(normalizeHexColor('#1D4ED8')).toBe('#1d4ed8');
    expect(normalizeHexColor(' #abc ')).toBe('#aabbcc');
    for (const bad of ['1d4ed8', '#1d4ed', '#1d4ed8ff', 'red', 'rgb(0,0,0)', '#1d4ed8;color:red', '#fff}body{x:y', 'var(--x)', '#12345g']) {
      expect(normalizeHexColor(bad), bad).toBeNull();
    }
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('picks text on the accent with at least 4.5:1 for every colour', () => {
    for (let n = 0; n < 0x1000000; n += 0x0f0f0f / 3) {
      const color = `#${Math.floor(n).toString(16).padStart(6, '0')}`;
      expect(contrastRatio(color, foregroundFor(color))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
    expect(foregroundFor('#1d4ed8')).toBe('#ffffff');
    expect(foregroundFor('#facc15')).toBe('#000000');
  });

  it('refuses accents that would be unreadable on the theme background', () => {
    expect(accentContrastProblem('#1d4ed8', 'light')).toBeNull();
    expect(accentContrastProblem('#facc15', 'light')).toMatch(/#facc15 has a contrast of 1\.[0-9]:1 against the light theme's background; it needs at least 3:1/);
    expect(accentContrastProblem('#1e1b4b', 'dark')).toMatch(/dark theme/);
  });

  it('derives a dark-theme accent that contrasts enough with the dark background', () => {
    expect(deriveDarkAccent('#2563eb')).toBe('#2563eb');
    const derived = deriveDarkAccent('#1e1b4b');
    expect(derived).not.toBe('#1e1b4b');
    expect(contrastRatio(derived, DARK_SURFACE)).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    const palette = accentPalette('#1e1b4b', null);
    expect(palette.dark.color).toBe(derived);
    expect(contrastRatio(palette.light.color, LIGHT_SURFACE)).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
  });

  it('makes the accent readable as text on both themes\' panels', () => {
    for (const color of ['#1e1b4b', '#5b49dc', '#facc15', '#60a5fa', '#1d4ed8']) {
      const dark = readableAccent(color, 'dark');
      const light = readableAccent(color, 'light');
      for (const surface of [DARK_SURFACE, '#1b1f27']) expect(contrastRatio(dark, surface), `${color} dark`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      for (const surface of [LIGHT_SURFACE, '#f4f5f8']) expect(contrastRatio(light, surface), `${color} light`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
    expect(readableAccent('#60a5fa', 'dark')).toBe('#60a5fa');
    expect(readableAccent('#1d4ed8', 'light')).toBe('#1d4ed8');
  });

  it('writes CSS only from normalised hex colours', () => {
    expect(accentCss(accentPalette('#1d4ed8', '#60a5fa'))).toBe(
      ':root,.dark{--brand-fill:#60a5fa;--on-brand-fill:#000000;--brand:#60a5fa;--brand-tint:color-mix(in srgb,#60a5fa 14%,transparent)}' +
        '.light{--brand-fill:#1d4ed8;--on-brand-fill:#ffffff;--brand:#1d4ed8;--brand-tint:color-mix(in srgb,#1d4ed8 9%,transparent)}'
    );
    const injected = { light: { color: '#000;}</style><script>alert(1)</script>', foreground: '#ffffff' }, dark: { color: '#ffffff', foreground: '#000000' } };
    expect(accentCss(injected)).toBe('');
  });
});

describe('parseBrandingInput', () => {
  it('accepts a full update and normalises it', () => {
    expect(parseBrandingInput({
      productName: '  Example Edge  ',
      accentColor: '#1D4ED8',
      accentColorDark: '#60A5FA',
      loginHeading: 'Sign in to Example Edge',
      loginFooter: 'Managed by Example IT.\r\nUnauthorised access is prohibited.',
      supportUrl: 'https://support.example.com',
      supportEmail: 'help@example.com',
      emailSenderName: 'Example Alerts',
      showPoweredBy: false,
    })).toEqual({
      productName: 'Example Edge',
      accentColor: '#1d4ed8',
      accentColorDark: '#60a5fa',
      loginHeading: 'Sign in to Example Edge',
      loginFooter: 'Managed by Example IT.\nUnauthorised access is prohibited.',
      supportUrl: 'https://support.example.com/',
      supportEmail: 'help@example.com',
      emailSenderName: 'Example Alerts',
      showPoweredBy: false,
    });
  });

  it('keeps fields that are left out and restores defaults for null or empty strings', () => {
    expect(parseBrandingInput({ productName: 'X' })).toEqual({ productName: 'X' });
    expect(parseBrandingInput({ productName: '', accentColor: null, supportUrl: '   ' })).toEqual({ productName: null, accentColor: null, supportUrl: null });
  });

  it.each([
    [[], 'Body must be a JSON object'],
    [{ productName: 'X', logo: 'x' }, 'Unknown field: logo'],
    [{ productName: 42 }, 'productName must be a string or null'],
    [{ productName: 'x'.repeat(61) }, 'productName must be at most 60 characters'],
    [{ productName: 'Example\u202eegdE' }, 'productName must not contain control or invisible formatting characters'],
    [{ productName: 'Exa\u200bmple' }, 'productName must not contain control or invisible formatting characters'],
    [{ productName: 'Line\nbreak' }, 'productName must not contain control or invisible formatting characters'],
    [{ emailSenderName: 'Ops\r\nBcc: victim@example.com' }, 'emailSenderName must not contain control or invisible formatting characters'],
    [{ loginFooter: 'tab\there' }, 'loginFooter must not contain control or invisible formatting characters'],
    [{ accentColor: 'red' }, 'accentColor must be a hex colour such as #1d4ed8'],
    [{ accentColor: '#000;background:url(//example.com)' }, 'accentColor must be a hex colour such as #1d4ed8'],
    [{ accentColor: '#facc15' }, /accentColor: #facc15 has a contrast of/],
    [{ accentColorDark: '#111111' }, /accentColorDark: #111111 has a contrast of .* dark theme/],
    [{ supportUrl: 'javascript:alert(1)' }, 'supportUrl must start with https:// or http://'],
    [{ supportUrl: 'data:text/html,hi' }, 'supportUrl must start with https:// or http://'],
    [{ supportUrl: 'https://user:pass@example.com' }, 'supportUrl must not contain a user name or password'],
    [{ supportUrl: 'not a url' }, 'supportUrl must be a valid URL'],
    [{ supportEmail: 'help@example.com?subject=x' }, 'supportEmail must be an e-mail address'],
    [{ supportEmail: 'nobody' }, 'supportEmail must be an e-mail address'],
    [{ showPoweredBy: 'no' }, 'showPoweredBy must be true or false'],
  ])('refuses %j', (body, message) => {
    expect(() => parseBrandingInput(body)).toThrow(message);
  });
});

describe('stored settings', () => {
  it('drops fields that no longer validate instead of failing', () => {
    expect(normalizeStoredSettings({
      productName: 'Example\u202e',
      accentColor: 'url(javascript:x)',
      supportUrl: 'javascript:alert(1)',
      supportEmail: 'help@example.com',
      showPoweredBy: 'yes',
    })).toEqual({ ...DEFAULT_BRANDING_SETTINGS, supportEmail: 'help@example.com' });
    expect(normalizeStoredSettings('garbage')).toEqual(DEFAULT_BRANDING_SETTINGS);
  });

  it('asks for a license only for values of your own', () => {
    const current = { ...DEFAULT_BRANDING_SETTINGS, productName: 'Example Edge', showPoweredBy: false };
    expect(fieldsNeedingLicense(current, { ...current, productName: null, showPoweredBy: true })).toEqual([]);
    expect(fieldsNeedingLicense(current, { ...current })).toEqual([]);
    expect(fieldsNeedingLicense(current, { ...current, productName: 'Other' })).toEqual(['productName']);
    expect(fieldsNeedingLicense(DEFAULT_BRANDING_SETTINGS, { ...DEFAULT_BRANDING_SETTINGS, showPoweredBy: false })).toEqual(['showPoweredBy']);
  });
});
