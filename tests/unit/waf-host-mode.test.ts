/**
 * The per-host WAF mode (inherit, off, detection only, block) over the stored
 * meta.waf fields, older stored values included, and what a host gets once
 * the global settings apply.
 */
import { describe, expect, it } from 'vitest';
import { hostModeOf, hostSettingsKind, hostWafDifferences, withHostMode } from '../../src/lib/waf-host-mode';
import { resolveEffectiveWaf } from '../../src/lib/caddy-waf';
import type { WafSettings } from '../../src/lib/settings';

const global: WafSettings = { enabled: false, mode: 'On', load_owasp_crs: true, custom_directives: '' };

describe('hostModeOf', () => {
  it.each([
    [null, 'inherit'],
    [{}, 'inherit'],
    [{ excluded_rule_ids: [1] }, 'inherit'],
    [{ enabled: true }, 'inherit'],
    [{ enabled: false, mode: 'On' as const }, 'off'],
    [{ enabled: true, mode: 'Off' as const }, 'off'],
    [{ enabled: true, mode: 'On' as const }, 'block'],
    [{ enabled: true, mode: 'DetectionOnly' as const }, 'detection_only'],
  ])('reads %j as %s', (waf, mode) => {
    expect(hostModeOf(waf)).toBe(mode);
  });
});

describe('withHostMode', () => {
  const stored = {
    enabled: true,
    waf_mode: 'override' as const,
    mode: 'On' as const,
    load_owasp_crs: true,
    custom_directives: 'SecRule ARGS "@contains x" "id:9001,deny"',
    excluded_rule_ids: [941100],
    request_body_limit: 67_108_864,
  };

  it('keeps every other setting', () => {
    expect(withHostMode(stored, 'detection_only')).toEqual({ ...stored, mode: 'DetectionOnly' });
    const { mode: _mode, ...rest } = stored;
    void _mode;
    expect(withHostMode(stored, 'inherit')).toEqual(rest);
  });

  it('turns the host off without losing its settings, and back on', () => {
    const off = withHostMode(stored, 'off');
    expect(off).toMatchObject({ enabled: false, mode: 'On', custom_directives: stored.custom_directives });
    expect(resolveEffectiveWaf({ ...global, enabled: true }, off)).toBeNull();
    expect(withHostMode(off, 'block')).toEqual({ ...stored, mode: 'On' });
  });

  it('gives a host without settings a merging section', () => {
    expect(withHostMode(null, 'block')).toEqual({ enabled: true, mode: 'On', waf_mode: 'merge' });
    expect(withHostMode(undefined, 'inherit')).toEqual({ enabled: true, waf_mode: 'merge' });
  });

  it('makes inherit use the global mode even when the global WAF does not apply to all hosts', () => {
    expect(resolveEffectiveWaf({ ...global, mode: 'DetectionOnly' }, withHostMode(null, 'inherit'))?.mode).toBe('DetectionOnly');
    expect(resolveEffectiveWaf(global, null)).toBeNull();
  });
});

describe('hostSettingsKind and hostWafDifferences', () => {
  it('tells following, merging, overriding and off apart', () => {
    expect(hostSettingsKind(global, null)).toBe('follows');
    expect(hostSettingsKind(global, { enabled: true, waf_mode: 'merge' })).toBe('follows');
    expect(hostSettingsKind(global, { enabled: true, waf_mode: 'merge' }, 2)).toBe('merges');
    expect(hostSettingsKind(global, { enabled: true, mode: 'DetectionOnly' })).toBe('merges');
    expect(hostSettingsKind(global, { enabled: true, waf_mode: 'override' })).toBe('overrides');
    expect(hostSettingsKind(global, { enabled: false })).toBe('off');
    expect(hostSettingsKind(global, { enabled: true, mode: 'Off' })).toBe('off');
  });

  it('lists what a host changes', () => {
    expect(hostWafDifferences(global, {
      enabled: true,
      mode: 'DetectionOnly',
      load_owasp_crs: false,
      custom_directives: 'SecRule ARGS "@contains x" "id:9001,deny"',
      request_body_limit: 67_108_864,
      request_body_limit_action: 'ProcessPartial',
    })).toEqual(['detection only', 'Core Rule Set off', 'custom rules', 'body limits', 'inspects the start of large bodies']);
    expect(hostWafDifferences(global, { enabled: true, load_owasp_crs: true })).toEqual([]);
  });
});
