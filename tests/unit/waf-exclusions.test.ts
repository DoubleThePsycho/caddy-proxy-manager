/**
 * Rule exclusion fields (rule id, path, variable) and the Coraza directives
 * they become. Paths and variable names end up inside SecLang, so the
 * validation is the security boundary: these tests try to break out of the
 * quoted operator and the ctl action.
 */
import { describe, expect, it } from 'vitest';
import {
  buildExclusionDirectives,
  exclusionRuleIdFor,
  normalizeVariable,
  parseWafExclusionMatch,
  pathError,
  ruleIdError,
  WAF_EXCLUSION_RULE_ID_BASE,
  WafExclusionInputError,
} from '../../src/lib/waf-exclusions';

describe('ruleIdError', () => {
  it.each([0, -1, 1.5, '942100', null, 2_147_483_648, Number.NaN])('refuses %j', (value) => {
    expect(ruleIdError(value)).toMatch(/ruleId must be an integer/);
  });

  it.each([949110, 949111, 959100, 959101])('refuses the anomaly evaluation rule %i', (id) => {
    expect(ruleIdError(id)).toMatch(/decides whether a request is blocked/);
  });

  it('refuses the range of generated exclusion rules', () => {
    expect(ruleIdError(WAF_EXCLUSION_RULE_ID_BASE + 3)).toMatch(/range the WAF uses/);
  });

  it('accepts CRS and custom rule ids', () => {
    expect(ruleIdError(942100)).toBeNull();
    expect(ruleIdError(9001)).toBeNull();
  });
});

describe('pathError', () => {
  it.each(['/', '/api/', '/api/public/otel/', '/wiki/Main_Page', "/a-b.c_d~e!f$g&h(i)j*k+l,m;n=o:p@q"])('accepts %s', (path) => {
    expect(pathError(path)).toBeNull();
  });

  it.each([
    ['', /non-empty/],
    ['api/', /start with \//],
    ['/a b', /no spaces/],
    ['/a"b', /no spaces, quotes/],
    ["/a'b", /quotes/],
    ['/a\\b', /contain only/],
    ['/a%2e%2e/admin', /%/],
    ['/a%{tx.x}', /%/],
    ['/a?x=1', /query string/],
    ['/a#b', /contain only/],
    ['/a\nSecRuleEngine Off', /contain only/],
    ['/über', /contain only/],
    ['/a//b', /\/\//],
    ['/a/./b', /\/\.\//],
    ['/a/../admin', /\/\.\.\//],
    ['/a/..', /\/\.\.\//],
    [`/${'a'.repeat(1024)}`, /at most 1024/],
  ])('refuses %j', (path, message) => {
    expect(pathError(path)).toMatch(message);
  });
});

describe('normalizeVariable', () => {
  it('upper-cases the collection and keeps the name', () => {
    expect(normalizeVariable('args:content')).toEqual({ variable: 'ARGS:content' });
    expect(normalizeVariable(' REQUEST_HEADERS:Content-Type ')).toEqual({ variable: 'REQUEST_HEADERS:Content-Type' });
    expect(normalizeVariable('REQUEST_COOKIES:session_id')).toEqual({ variable: 'REQUEST_COOKIES:session_id' });
    expect(normalizeVariable('ARGS:json.items.0.body')).toEqual({ variable: 'ARGS:json.items.0.body' });
    expect(normalizeVariable('ARGS:user[name]')).toEqual({ variable: 'ARGS:user[name]' });
    expect(normalizeVariable('REQUEST_BODY')).toEqual({ variable: 'REQUEST_BODY' });
    expect(normalizeVariable('ARGS')).toEqual({ variable: 'ARGS' });
  });

  it.each([
    ['TX:anomaly_score', /must name one of/],
    ['ENV:PATH', /must name one of/],
    ['ARGS:', /the name after ARGS/],
    ['ARGS:/^json\\./', /the name after ARGS/],
    ['ARGS:a,ctl:ruleEngine=Off', /the name after ARGS/],
    ["ARGS:a'b", /the name after ARGS/],
    ['ARGS:a"b', /the name after ARGS/],
    ['ARGS:a b', /the name after ARGS/],
    ['ARGS:a;REQUEST_BODY', /the name after ARGS/],
    ['ARGS:-x', /the name after ARGS/],
    ['REQUEST_BODY:x', /takes no name/],
    ['', /non-empty/],
  ])('refuses %j', (variable, message) => {
    const result = normalizeVariable(variable);
    expect('error' in result && result.error).toMatch(message);
  });
});

describe('parseWafExclusionMatch', () => {
  it('defaults the path match to prefix for a trailing slash, else exact', () => {
    expect(parseWafExclusionMatch({ ruleId: 920420, path: '/api/public/otel/' })).toEqual({
      ruleId: 920420,
      pathMatch: 'prefix',
      path: '/api/public/otel/',
      variable: null,
    });
    expect(parseWafExclusionMatch({ ruleId: 920420, path: '/upload' }).pathMatch).toBe('exact');
    expect(parseWafExclusionMatch({ ruleId: 920420, path: '/upload', pathMatch: 'prefix' }).pathMatch).toBe('prefix');
  });

  it('treats empty fields as absent', () => {
    expect(parseWafExclusionMatch({ ruleId: 911100, path: '', variable: '' })).toEqual({ ruleId: 911100, pathMatch: null, path: null, variable: null });
  });

  it('refuses a path match without a path, and an unknown one', () => {
    expect(() => parseWafExclusionMatch({ ruleId: 1, pathMatch: 'exact' })).toThrow(/pathMatch needs a path/);
    expect(() => parseWafExclusionMatch({ ruleId: 1, path: '/a', pathMatch: 'regex' })).toThrow(WafExclusionInputError);
  });

  it('lets stored rows keep an anomaly evaluation rule id', () => {
    expect(() => parseWafExclusionMatch({ ruleId: 949110 })).toThrow(/decides/);
    expect(parseWafExclusionMatch({ ruleId: 949110 }, { anyRuleId: true }).ruleId).toBe(949110);
  });
});

describe('buildExclusionDirectives', () => {
  it('removes whole-scope exclusions with SecRuleRemoveById, sorted and once', () => {
    const result = buildExclusionDirectives([
      { id: 1, ruleId: 942100, pathMatch: null, path: null, variable: null },
      { id: 2, ruleId: 913100, pathMatch: null, path: null, variable: null },
      { id: 3, ruleId: 942100, pathMatch: null, path: null, variable: null },
    ]);
    expect(result).toEqual({ removedRuleIds: [913100, 942100], rules: [], ruleIds: [], skipped: [] });
  });

  it('writes a path exclusion as a phase 1 rule on the normalized path', () => {
    const { rules, ruleIds } = buildExclusionDirectives([
      { id: 12, ruleId: 920420, pathMatch: 'prefix', path: '/api/public/otel/', variable: null },
      { id: 13, ruleId: 920420, pathMatch: 'exact', path: '/upload', variable: null },
    ]);
    expect(rules).toEqual([
      'SecRule REQUEST_FILENAME "@beginsWith /api/public/otel/" "id:1900000012,phase:1,pass,t:none,t:normalizePath,nolog,ctl:ruleRemoveById=920420"',
      'SecRule REQUEST_FILENAME "@streq /upload" "id:1900000013,phase:1,pass,t:none,t:normalizePath,nolog,ctl:ruleRemoveById=920420"',
    ]);
    expect(ruleIds).toEqual([1900000012, 1900000013]);
  });

  it('writes a variable exclusion with ctl:ruleRemoveTargetById, behind the path when there is one', () => {
    const { rules } = buildExclusionDirectives([
      { id: 1, ruleId: 942100, pathMatch: null, path: null, variable: 'ARGS:content' },
      { id: 2, ruleId: 942100, pathMatch: 'prefix', path: '/wiki/', variable: 'args:content' },
    ]);
    expect(rules).toEqual([
      'SecAction "id:1900000001,phase:1,pass,t:none,nolog,ctl:ruleRemoveTargetById=942100;ARGS:content"',
      'SecRule REQUEST_FILENAME "@beginsWith /wiki/" "id:1900000002,phase:1,pass,t:none,t:normalizePath,nolog,ctl:ruleRemoveTargetById=942100;ARGS:content"',
    ]);
  });

  it('writes one rule per distinct exclusion (a global and a host copy collapse)', () => {
    const { rules } = buildExclusionDirectives([
      { id: 1, ruleId: 942100, pathMatch: null, path: null, variable: 'ARGS:q' },
      { id: 2, ruleId: 942100, pathMatch: null, path: null, variable: 'ARGS:q' },
    ]);
    expect(rules).toHaveLength(1);
  });

  it('leaves out stored rows that would break out of the directive, and reports them', () => {
    const hostile = [
      { id: 1, ruleId: 942100, pathMatch: 'exact', path: '/a" "id:5,phase:1,pass,nolog,ctl:ruleEngine=Off', variable: null },
      { id: 2, ruleId: 942100, pathMatch: 'exact', path: '/a\nSecRuleEngine Off', variable: null },
      { id: 3, ruleId: 942100, pathMatch: null, path: null, variable: 'ARGS:x,ctl:ruleEngine=Off' },
      { id: 4, ruleId: 942100, pathMatch: null, path: null, variable: "ARGS:x'" },
      { id: 5, ruleId: 942100, pathMatch: 'regex', path: '/a', variable: null },
      { id: 6, ruleId: -1, pathMatch: null, path: null, variable: null },
      { id: 7, ruleId: 942100, pathMatch: 'exact', path: '/%{tx.x}', variable: null },
    ];
    const result = buildExclusionDirectives(hostile);
    expect(result.rules).toEqual([]);
    expect(result.removedRuleIds).toEqual([]);
    expect(result.skipped.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('skips a row whose id leaves no room for its generated rule id', () => {
    const result = buildExclusionDirectives([{ id: 2_000_000_000, ruleId: 942100, pathMatch: null, path: null, variable: 'ARGS:q' }]);
    expect(result.rules).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(exclusionRuleIdFor(1)).toBe(1_900_000_001);
    expect(exclusionRuleIdFor(0)).toBeNull();
  });
});
