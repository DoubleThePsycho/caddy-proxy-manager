/**
 * Virtual patches in the WAF handler (buildWafHandler): after the runtime
 * exclusions and before the Core Rule Set rules, in every handler, held to
 * the reserved id range by the custom directive filter (a second net behind
 * the feed renderer); and custom rules kept out of that range.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWafHandler, buildWafHandlerEntry, customDirectivesError, filterCustomDirectives } from '@/src/lib/caddy-waf';
import { renderPackRules, validatePackRules } from '@/ee/rule-feed/seclang';
import { examplePack } from '../helpers/rule-feed';

const pack = examplePack('ivp-2021-44228');
const blockRules = renderPackRules(pack, validatePackRules(pack.rules, 'pack').rules, 'block');
const detectRules = renderPackRules(pack, validatePackRules(pack.rules, 'pack').rules, 'detect');
const waf = { enabled: true, mode: 'On' as const, load_owasp_crs: true, custom_directives: 'SecRule REQUEST_URI "@contains /admin" "id:9001,phase:1,deny,status:403"' };

function lines(handler: Record<string, unknown>): string[] {
  return String(handler.directives).split('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('virtual patches in the WAF handler', () => {
  it('go after the runtime exclusions and before the Core Rule Set rules', () => {
    const exclusion = { id: 7, ruleId: 942100, pathMatch: 'prefix', path: '/api/', variable: null };
    const out = lines(buildWafHandler(waf, 'test', [exclusion], { rules: blockRules }));
    const patch = out.findIndex((line) => line.includes('id:1800000101'));
    expect(patch).toBeGreaterThan(out.findIndex((line) => line.includes('ctl:ruleRemoveById=942100')));
    expect(patch).toBeLessThan(out.indexOf('Include @owasp_crs/*.conf'));
    expect(patch).toBeLessThan(out.indexOf('SecRuleEngine On'));
    expect(patch).toBeLessThan(out.findIndex((line) => line.includes('id:9001')));
    expect(out[patch]).toContain('deny,status:403');
    expect(out[patch]).toContain("msg:'CVE-2021-44228 CVE-2021-45046 Apache Log4j JNDI lookup injection (Log4Shell)'");
  });

  it('go into handlers without the Core Rule Set too, and in detection mode only log', () => {
    const out = lines(buildWafHandler({ ...waf, load_owasp_crs: false }, 'test', [], { rules: detectRules }));
    const patch = out.find((line) => line.includes('id:1800000101'))!;
    expect(patch).toContain('phase:2,pass,log,auditlog');
    expect(out.indexOf(patch)).toBeLessThan(out.indexOf('SecRuleEngine On'));
    expect(out.some((line) => line.startsWith('Include'))).toBe(false);
  });

  it('wrap the same way for WebSocket hosts, and leave the handler as before without patches', () => {
    const entry = buildWafHandlerEntry(waf, true, 'test', [], { rules: blockRules }) as { routes: { handle: Record<string, unknown>[] }[] };
    expect(String(entry.routes[0].handle[0].directives)).toContain('id:1800000101');
    expect(buildWafHandler(waf, 'test', [], null)).toEqual(buildWafHandler(waf, 'test', []));
  });

  it('leave out anything that is not a rule in the reserved range, and say so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const smuggled = [
      ...blockRules,
      'SecRuleEngine Off',
      'SecRule ARGS "@rx ." "id:942100,phase:1,deny"',
      'SecRule ARGS "@rx ." "phase:1,pass,ctl:ruleEngine=Off"',
      'Include /etc/passwd',
    ];
    const out = String(buildWafHandler(waf, 'test', [], { rules: smuggled }).directives);
    expect(out).toContain('id:1800000101');
    expect(out).not.toContain('SecRuleEngine Off');
    expect(out).not.toContain('id:942100');
    expect(out).not.toContain('ctl:ruleEngine=Off');
    expect(out).not.toContain('/etc/passwd');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[waf\] virtual patches: 4 custom directive line\(s\)/));
  });

  it('keep custom rules out of the reserved range', () => {
    const custom = 'SecRule REQUEST_URI "@contains /x" "id:1800000101,phase:1,deny,status:403"';
    expect(filterCustomDirectives(custom).dropped[0].reason).toMatch(/reserved for virtual patches \(1800000000-1800999999\)/);
    expect(customDirectivesError(custom)).toMatch(/reserved for virtual patches/);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = String(buildWafHandler({ ...waf, custom_directives: custom }, 'test', [], { rules: blockRules }).directives);
    // Only the patch's rule has the id: the custom rule is left out, so Coraza never sees a duplicate.
    expect(out.split('id:1800000101').length).toBe(2);
    expect(out).toContain("msg:'CVE-2021-44228");
  });
});
