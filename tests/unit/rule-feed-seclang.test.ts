/**
 * The SecLang a rule feed may contain (ee/rule-feed/seclang.ts): the
 * allowlist of directives, variables, operators, transformations and actions,
 * with attempts to switch the engine off, remove or change rules, hide
 * matches, touch the container or smuggle lines in; and the rules Ingressi
 * renders from a feed rule in each mode.
 */
import { describe, expect, it } from 'vitest';
import { filterCustomDirectives } from '@/src/lib/caddy-waf';
import {
  parseFeedRule,
  regexProblem,
  renderPackRules,
  RuleFeedError,
  validatePackRules,
  validateRenderablePack,
} from '@/ee/rule-feed/seclang';

const RULE = 'SecRule ARGS|REQUEST_HEADERS:User-Agent "@rx (?i)jndi:" "id:1800000001,phase:2,t:none,t:urlDecodeUni"';
const PACK = { id: 'ivp-test-0001', title: 'Example lookup injection', cves: ['CVE-2026-0001'], severity: 'critical' as const };

function refused(rule: string, chained = false): string {
  try {
    parseFeedRule(rule, chained, 'pack x');
  } catch (error) {
    expect(error).toBeInstanceOf(RuleFeedError);
    return (error as Error).message;
  }
  throw new Error(`accepted: ${rule}`);
}

describe('feed rule allowlist', () => {
  it('parses an allowed rule into its parts', () => {
    expect(parseFeedRule(RULE, false, 'pack x')).toEqual({
      variables: [
        { negated: false, count: false, name: 'ARGS', key: null },
        { negated: false, count: false, name: 'REQUEST_HEADERS', key: 'User-Agent' },
      ],
      operator: { negated: false, name: 'rx', argument: '(?i)jndi:' },
      id: 1800000001,
      phase: 2,
      transformations: ['urlDecodeUni'],
      chain: false,
      capture: false,
      multiMatch: false,
    });
  });

  it('refuses every directive but SecRule', () => {
    for (const directive of [
      'SecRuleEngine Off',
      'SecRuleEngine DetectionOnly',
      'SecRuleRemoveById 1-999999',
      'SecRuleRemoveByTag attack-sqli',
      'SecRuleRemoveByMsg .',
      'SecRuleUpdateActionById 949110 "pass"',
      'SecRuleUpdateTargetById 942100 "!ARGS"',
      'SecAction "id:1800000001,phase:1,pass,nolog,ctl:ruleEngine=Off"',
      'SecDefaultAction "phase:2,log,auditlog,pass"',
      'SecMarker END',
      'Include /etc/passwd',
      'Include @owasp_crs/*.conf',
      'SecRequestBodyAccess Off',
      'SecAuditEngine Off',
    ]) {
      expect(refused(directive), directive).toMatch(/not allowed in feed rules|must read SecRule/);
    }
  });

  it('refuses actions that could weaken the WAF, hide matches or touch the container', () => {
    const cases: Record<string, RegExp> = {
      'ctl:ruleEngine=Off': /action ctl is not allowed/,
      'ctl:ruleRemoveById=949110': /action ctl is not allowed/,
      'ctl:ruleRemoveTargetById=942100;ARGS': /action ctl is not allowed/,
      'ctl:requestBodyAccess=Off': /action ctl is not allowed/,
      'ctl:auditEngine=Off': /action ctl is not allowed/,
      "setvar:'tx.inbound_anomaly_score_threshold=10000'": /action setvar is not allowed/,
      'setvar:tx.blocking_paranoia_level=0': /action setvar is not allowed/,
      'setenv:LD_PRELOAD=/tmp/x.so': /action setenv is not allowed/,
      'exec:/bin/sh': /action exec is not allowed/,
      'skipAfter:END-REQUEST': /action skipAfter is not allowed/,
      'skip:100': /action skip is not allowed/,
      allow: /action allow is not allowed/,
      pass: /action pass is not allowed/,
      deny: /action deny is not allowed/,
      'status:200': /action status is not allowed/,
      nolog: /action nolog is not allowed/,
      noauditlog: /action noauditlog is not allowed/,
      "msg:'%{REQUEST_HEADERS.Authorization}'": /action msg is not allowed/,
      "logdata:'%{REQUEST_HEADERS.Authorization}'": /action logdata is not allowed/,
      "tag:'x'": /action tag is not allowed/,
      'severity:CRITICAL': /action severity is not allowed/,
      'initcol:ip=%{REMOTE_ADDR}': /action initcol is not allowed/,
      'expirevar:ip.x=1': /action expirevar is not allowed/,
      'redirect:https://example.com/': /action redirect is not allowed/,
      'proxy:http://example.com/': /action proxy is not allowed/,
    };
    for (const [action, reason] of Object.entries(cases)) {
      expect(refused(`SecRule ARGS "@rx x" "id:1800000001,phase:2,${action}"`), action).toMatch(reason);
    }
    // Spacing or case that Coraza would strip does not get past the parser either.
    expect(refused('SecRule ARGS "@rx x" "id:1800000001,phase:2, ctl:ruleEngine=Off"')).toMatch(/is not an action/);
    expect(refused('SecRule ARGS "@rx x" "id:1800000001,phase:2,CTL:ruleEngine=Off"')).toMatch(/action CTL is not allowed/);
    expect(refused('SecRule ARGS "@rx x" "id:1800000001,phase:2,t:none,t:urlDecodeUni ,nolog"')).toMatch(/not written key or key:value/);
  });

  it('refuses operators that read files, run programs or reach the network', () => {
    for (const operator of [
      '@pmFromFile /etc/passwd',
      '@pmf /etc/passwd',
      '@ipMatchFromFile /etc/hosts',
      '@ipMatchF /etc/hosts',
      '@inspectFile /bin/sh',
      '@validateSchema /etc/schema.xsd',
      '@rbl bl.example.com',
      '@geoLookup',
      '@unconditionalMatch',
      '@noMatch',
      // Not registered in Coraza v3.7.0: Caddy would refuse the whole configuration.
      '@containsWord admin',
    ]) {
      expect(refused(`SecRule ARGS "${operator}" "id:1800000001,phase:2"`), operator).toMatch(/operator .* is not allowed/);
    }
    expect(refused('SecRule ARGS "jndi" "id:1800000001,phase:2"')).toMatch(/@name/);
  });

  it('refuses variables outside the request, and malformed keys', () => {
    for (const variable of ['RESPONSE_BODY', 'RESPONSE_HEADERS', 'ENV', 'GEO', 'RULE', 'UNIQUE_ID', 'XML:/*', 'ARGS|RESPONSE_BODY']) {
      expect(refused(`SecRule ${variable} "@rx x" "id:1800000001,phase:2"`), variable).toMatch(/not allowed|is not a variable/);
    }
    expect(refused('SecRule TX:anomaly_score "@gt 0" "id:1800000001,phase:2"')).toMatch(/key of TX/);
    expect(refused('SecRule REQUEST_METHOD:GET "@rx x" "id:1800000001,phase:2"')).toMatch(/takes no key/);
    expect(refused('SecRule !ARGS "@rx x" "id:1800000001,phase:2"')).toMatch(/needs a key/);
    expect(refused('SecRule ARGS:a"b "@rx x" "id:1800000001,phase:2"')).toMatch(/must read SecRule/);
    expect(parseFeedRule('SecRule ARGS|!ARGS:password|&REQUEST_HEADERS:/^x-/ "@rx x" "id:1800000001,phase:2"', false, 'p').variables).toHaveLength(3);
  });

  it('keeps ids in the reserved range and phases to the request', () => {
    expect(refused('SecRule ARGS "@rx x" "id:942100,phase:2"')).toMatch(/outside the range reserved for virtual patches/);
    expect(refused('SecRule ARGS "@rx x" "id:949110,phase:2"')).toMatch(/outside the range/);
    expect(refused('SecRule ARGS "@rx x" "id:1900000001,phase:2"')).toMatch(/outside the range/);
    expect(refused('SecRule ARGS "@rx x" "phase:2"')).toMatch(/needs the id and phase/);
    expect(refused('SecRule ARGS "@rx x" "id:1800000001"')).toMatch(/needs the id and phase/);
    expect(refused('SecRule ARGS "@rx x" "id:1800000001,phase:3"')).toMatch(/phase must be 1 or 2/);
    expect(refused('SecRule ARGS "@rx x" "id:1800000001,phase:2,id:1800000002"')).toMatch(/appears twice/);
    // A chained rule takes neither.
    expect(refused('SecRule ARGS "@rx x" "id:1800000002"', true)).toMatch(/action id is not allowed in a chained rule/);
    expect(refused('SecRule ARGS "@rx x" "phase:1"', true)).toMatch(/action phase is not allowed in a chained rule/);
  });

  it('refuses anything that could change how Coraza reads the line', () => {
    expect(refused(`${RULE}\nSecRuleEngine Off`)).toMatch(/one line of printable ASCII/);
    expect(refused(`${RULE}\r`)).toMatch(/one line of printable ASCII/);
    expect(refused(RULE.replace(' "@rx', '\t"@rx'))).toMatch(/one line of printable ASCII|must read SecRule/);
    expect(refused(RULE.replace(' "@rx', '\u0085"@rx'))).toMatch(/one line of printable ASCII/);
    expect(refused(`${RULE} \\`)).toMatch(/must read SecRule/);
    expect(refused('SecRule ARGS "@rx x\\" "id:1800000001,phase:2"')).toMatch(/ends with a backslash/);
    expect(refused('SecRule ARGS "@rx a"b" "id:1800000001,phase:2"')).toMatch(/must read SecRule/);
    expect(refused('SecRule ARGS "@rx  x" "id:1800000001,phase:2"')).toMatch(/starts or ends with a space/);
    expect(refused('SecRule ARGS "@streq %{REQUEST_HEADERS.host}" "id:1800000001,phase:2"')).toMatch(/macros/);
    expect(refused(`SecRule ARGS "@rx ${'a'.repeat(5000)}" "id:1800000001,phase:2"`)).toMatch(/longer than 4096/);
    expect(refused('SecRule ARGS "@detectSQLi x" "id:1800000001,phase:2"')).toMatch(/takes no argument/);
    expect(refused('SecRule ARGS "@gt x" "id:1800000001,phase:2"')).toMatch(/takes an integer/);
    expect(refused('SecRule ARGS "@validateByteRange 0-300" "id:1800000001,phase:2"')).toMatch(/0 to 255/);
    expect(refused('SecRule ARGS "@rx x" "id:1800000001,phase:2,t:sha1"')).toMatch(/transformation t:sha1 is not allowed/);
    expect(refused('SecRule ARGS "@rx x" "id:1800000001,phase:2,t:sqlHexDecode"')).toMatch(/transformation t:sqlHexDecode is not allowed/);
  });

  it('refuses regular expressions RE2 cannot compile', () => {
    expect(regexProblem('(?i)(?:\\$|&dollar;?)(?:\\{|&l(?:brace|cub);?)(?:[^}]{0,15}(?:\\$|&dollar;?)|jndi)')).toBeNull();
    expect(regexProblem('[]a]+?')).toBeNull();
    expect(regexProblem('a{2,1000}')).toBeNull();
    expect(regexProblem('(?=admin)')).toMatch(/lookarounds/);
    expect(regexProblem('(?<!a)b')).toMatch(/lookarounds/);
    expect(regexProblem('(?<name>a)')).toMatch(/named groups/);
    expect(regexProblem('(a)\\1')).toMatch(/backreferences/);
    expect(regexProblem('a++')).toMatch(/possessive/);
    expect(regexProblem('a{2}+')).toMatch(/possessive/);
    expect(regexProblem('\\Z')).toMatch(/not supported/);
    expect(regexProblem('a{1001}')).toMatch(/above 1000/);
    expect(regexProblem('[abc')).toMatch(/not closed/);
    expect(regexProblem('(a')).toMatch(/not a valid regular expression/);
  });
});

describe('pack rules', () => {
  it('needs complete chains and unique ids', () => {
    const chain = [
      'SecRule REQUEST_FILENAME "@endsWith /upload" "id:1800000001,phase:2,t:none,chain"',
      'SecRule FILES_NAMES "@rx \\.jsp$" "t:lowercase"',
    ];
    expect(validatePackRules(chain, 'pack x')).toMatchObject({ ruleIds: [1800000001], inspectsBody: true });
    expect(() => validatePackRules([chain[0]], 'pack x')).toThrow(/last rule has chain/);
    expect(() => validatePackRules([RULE, RULE], 'pack x')).toThrow(/used twice/);
    expect(() => validatePackRules([], 'pack x')).toThrow(/non-empty/);
    expect(() => validatePackRules(Array.from({ length: 21 }, () => RULE), 'pack x')).toThrow(/at most 20/);
    expect(validatePackRules([RULE.replace('phase:2', 'phase:1')], 'pack x').inspectsBody).toBe(false);
  });

  it('renders the action of the mode, a message, tags and redactable log data', () => {
    const { rules } = validatePackRules([RULE], 'pack x');
    const [block] = renderPackRules(PACK, rules, 'block');
    expect(block).toBe(
      'SecRule ARGS|REQUEST_HEADERS:User-Agent "@rx (?i)jndi:" "id:1800000001,phase:2,deny,status:403,log,auditlog,' +
        "msg:'CVE-2026-0001 Example lookup injection',logdata:'Matched Data: %{MATCHED_VAR} found within %{MATCHED_VAR_NAME}'," +
        "severity:'CRITICAL',tag:'ingressi/virtual-patch',tag:'virtual-patch/ivp-test-0001',tag:'CVE-2026-0001',t:none,t:urlDecodeUni\""
    );
    const [detect] = renderPackRules(PACK, rules, 'detect');
    expect(detect).toContain('phase:2,pass,log,auditlog');
    expect(detect).not.toContain('deny');
  });

  it('renders chained rules with flags only', () => {
    const { rules } = validatePackRules(
      ['SecRule REQUEST_METHOD "@streq POST" "id:1800000001,phase:2,chain"', 'SecRule ARGS_NAMES "@rx ^class\\." "t:lowercase,capture"'],
      'pack x'
    );
    const rendered = renderPackRules(PACK, rules, 'block');
    expect(rendered[0]).toMatch(/,t:none,chain"$/);
    expect(rendered[1]).toBe('SecRule ARGS_NAMES "@rx ^class\\." "t:none,t:lowercase,capture"');
    // The Caddy config builder keeps the chain whole.
    const kept = filterCustomDirectives(rendered.join('\n'), { ruleIdRange: 'virtual_patch' });
    expect(kept).toEqual({ kept: rendered, dropped: [] });
  });

  it('keeps feed text out of SecLang: the message is reduced to safe characters', () => {
    const { rules } = validatePackRules([RULE], 'pack x');
    const [line] = renderPackRules({ ...PACK, title: "Bad', ctl:ruleEngine=Off, x='\" %{TX.0} \\" }, rules, 'block');
    expect(line).toContain("msg:'CVE-2026-0001 Bad ctl:ruleEngine Off x TX.0'");
    expect(filterCustomDirectives(line, { ruleIdRange: 'virtual_patch' }).dropped.length).toBeGreaterThan(0);
    expect(() => validateRenderablePack({ ...PACK, title: 'ctl:ruleEngine bypass' }, [RULE], 'pack x')).toThrow(/would not be applied/);
  });

  it('renders rules the Caddy config builder keeps', () => {
    const { rules } = validatePackRules([RULE], 'pack x');
    for (const mode of ['detect', 'block'] as const) {
      const text = renderPackRules(PACK, rules, mode).join('\n');
      expect(filterCustomDirectives(text, { ruleIdRange: 'virtual_patch' }).dropped).toEqual([]);
      // As custom rules they would be refused: the range is reserved.
      expect(filterCustomDirectives(text).dropped[0].reason).toMatch(/reserved for virtual patches/);
    }
  });
});
