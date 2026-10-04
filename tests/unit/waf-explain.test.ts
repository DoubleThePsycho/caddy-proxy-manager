/**
 * "Why was this request blocked": the parser of stored Coraza audit records
 * (waf_events.raw_data), on hand-written records shaped like those
 * coraza-caddy v2.6 / Coraza v3.7 writes with SecAuditLogParts ABFHZ (part H
 * messages: the ModSecurity-format error log line of each matched rule) and
 * with part K (structured data).
 */
import { describe, expect, it } from 'vitest';
import { explainWafAuditRecord, goUnquote, matchedVariableOf, requestPathOf, WafExplainError } from '../../src/lib/waf-explain';

const UNIQUE_ID = 'nDLkXnTNSxQmfKGTSAN';

/** A Go %q string (JSON escaping matches it for these ASCII fixtures). */
const q = (value: string) => JSON.stringify(value);

/** One rule's error log line, as Coraza's MatchedRule.ErrorLog writes it. */
function errorLog(rule: {
  id: number;
  msg: string;
  data?: string;
  severity?: string;
  action?: string;
  file?: string;
  tags?: string[];
  uri?: string;
}): string {
  const prefix = rule.action ?? 'Coraza: Warning.';
  const details =
    `[file ${q(rule.file ?? '@owasp_crs/REQUEST-942-APPLICATION-ATTACK-SQLI.conf')}] [line "4242"] [id ${q(String(rule.id))}] [rev ""] ` +
    `[msg ${q(rule.msg)}] [data ${q(rule.data ?? '')}] [severity ${q(rule.severity ?? 'unknown')}] [ver "OWASP_CRS/4.25.0"] ` +
    `[maturity "0"] [accuracy "0"]` +
    (rule.tags ?? []).map((tag) => ` [tag ${q(tag)}]`).join('') +
    ` [hostname "172.18.0.5"] [uri ${q(rule.uri ?? '/')}] [unique_id ${q(UNIQUE_ID)}]`;
  return `[client "203.0.113.66"] ${prefix} ${rule.msg} ${details}`;
}

function record(options: {
  uri: string;
  method?: string;
  interrupted: boolean;
  messages: unknown[];
  headers?: Record<string, string[]>;
}): string {
  return JSON.stringify({
    transaction: {
      timestamp: '2026/10/02 11:02:41',
      unix_timestamp: 1790938961000000000,
      id: UNIQUE_ID,
      client_ip: '203.0.113.66',
      client_port: 51234,
      host_ip: '172.18.0.5',
      host_port: 443,
      server_id: '',
      request: {
        method: options.method ?? 'GET',
        protocol: 'HTTP/2.0',
        uri: options.uri,
        http_version: '2.0',
        headers: options.headers ?? { host: ['app.example.com'], 'user-agent': ['Mozilla/5.0'] },
        body: '',
        files: null,
        args: {},
        length: 0,
      },
      response: { protocol: '', status: options.interrupted ? 403 : 200, headers: {}, body: '' },
      producer: { connector: 'coraza-caddy', version: 'v2.6.1', server: '', rule_engine: 'On', stopwatch: '', rulesets: ['OWASP_CRS/4.25.0'] },
      highest_severity: '',
      is_interrupted: options.interrupted,
    },
    messages: options.messages,
  });
}

const partH = (line: string) => ({ actionset: '', message: '', error_message: line, data: null });

const EVALUATION = (score: number, action = 'Coraza: Access denied (phase 2).') =>
  partH(errorLog({
    id: 949110,
    action,
    msg: `Inbound Anomaly Score Exceeded (Total Score: ${score})`,
    file: '@owasp_crs/REQUEST-949-BLOCKING-EVALUATION.conf',
    tags: ['anomaly-evaluation', 'OWASP_CRS'],
  }));

describe('explainWafAuditRecord on a blocked file access probe', () => {
  const raw = record({
    uri: '/.git/config',
    interrupted: true,
    messages: [
      partH(errorLog({
        id: 930130,
        msg: 'Restricted File Access Attempt',
        data: 'Matched Data: /.git/ found within REQUEST_FILENAME: /.git/config',
        severity: 'critical',
        file: '@owasp_crs/REQUEST-930-APPLICATION-ATTACK-LFI.conf',
        tags: ['application-multi', 'attack-lfi', 'paranoia-level/1', 'OWASP_CRS', 'OWASP_CRS/ATTACK-LFI'],
        uri: '/.git/config',
      })),
      EVALUATION(5),
    ],
  });

  it('lists the matched rules with their points, the score against the threshold and the deciding rule', () => {
    const explanation = explainWafAuditRecord(raw, { proxyHost: { id: 4, name: 'App' }, eventId: UNIQUE_ID });
    expect(explanation.blocked).toBe(true);
    expect(explanation.rules[0]).toMatchObject({
      ruleId: 930130,
      kind: 'attack',
      message: 'Restricted File Access Attempt',
      severity: 'critical',
      paranoiaLevel: 1,
      anomalyPoints: 5,
      countedInScore: true,
      matchedVariable: 'REQUEST_FILENAME',
      matchedData: 'Matched Data: /.git/ found within REQUEST_FILENAME: /.git/config',
      disruptive: false,
    });
    expect(explanation.rules[1]).toMatchObject({ ruleId: 949110, kind: 'inbound_evaluation', disruptive: true, phase: 2, severity: null, anomalyPoints: null });
    expect(explanation.inboundScore).toBe(5);
    expect(explanation.inboundScoreSource).toBe('record');
    expect(explanation.inboundThreshold).toBe(5);
    expect(explanation.thresholdSource).toBe('settings');
    expect(explanation.decidingRule).toEqual({
      ruleId: 949110,
      message: 'Inbound Anomaly Score Exceeded (Total Score: 5)',
      kind: 'inbound_evaluation',
      blocked: true,
    });
    expect(explanation.summary).toBe('Blocked: the anomaly score reached 5, the limit is 5.');
    expect(explanation.request).toMatchObject({ method: 'GET', uri: '/.git/config', host: 'app.example.com', clientIp: '203.0.113.66' });
  });

  it('suggests the rule on that host and path, without a variable for a non-keyed match', () => {
    const { suggestions } = explainWafAuditRecord(raw, { proxyHost: { id: 4, name: 'App' }, eventId: UNIQUE_ID });
    expect(suggestions).toEqual([
      {
        ruleId: 930130,
        proxyHostId: 4,
        hostName: 'App',
        pathMatch: 'exact',
        path: '/.git/config',
        variable: null,
        reason: `Suggested from WAF event ${UNIQUE_ID}`,
        description: 'Skip rule 930130 on App, for requests to /.git/config. Every other rule still checks these requests.',
      },
    ]);
  });

  it('suggests a global exclusion when no proxy host serves the request', () => {
    const { suggestions } = explainWafAuditRecord(raw);
    expect(suggestions[0]).toMatchObject({ proxyHostId: null, hostName: null });
    expect(suggestions[0].description).toMatch(/on every host that follows the global settings/);
  });
});

describe('explainWafAuditRecord on SQL injection in an argument', () => {
  const raw = record({
    uri: '/wiki/save?title=Runbook&token=[redacted]',
    method: 'POST',
    interrupted: true,
    messages: [
      partH(errorLog({
        id: 942100,
        msg: 'SQL Injection Attack Detected via libinjection',
        data: 'Matched Data: s&sos found within ARGS:content: select * from users where id = 1',
        severity: 'critical',
        tags: ['attack-sqli', 'paranoia-level/1', 'OWASP_CRS'],
      })),
      partH(errorLog({
        id: 942430,
        msg: 'Restricted SQL Character Anomaly Detection (args): # of special characters exceeded (12)',
        data: 'Matched Data: = 1 found within ARGS:content: select * from users where id = 1',
        severity: 'warning',
        tags: ['attack-sqli', 'paranoia-level/2', 'OWASP_CRS'],
      })),
      EVALUATION(5),
    ],
  });

  it('counts only rules up to the blocking paranoia level', () => {
    const explanation = explainWafAuditRecord(raw, { blockingParanoiaLevel: 1 });
    const [sqli, special] = explanation.rules;
    expect(sqli).toMatchObject({ anomalyPoints: 5, countedInScore: true, matchedVariable: 'ARGS:content' });
    expect(special).toMatchObject({ paranoiaLevel: 2, anomalyPoints: 0, countedInScore: false, matchedVariable: 'ARGS:content' });
    expect(explanation.inboundScore).toBe(5);
  });

  it('counts the level 2 rule at paranoia level 2', () => {
    const explanation = explainWafAuditRecord(raw, { blockingParanoiaLevel: 2 });
    expect(explanation.rules[1]).toMatchObject({ anomalyPoints: 3, countedInScore: true });
  });

  it('suggests the matched variable on the decoded path without the query string, once per rule', () => {
    const { suggestions } = explainWafAuditRecord(raw, { proxyHost: { id: 9, name: 'Wiki' } });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ ruleId: 942100, path: '/wiki/save', pathMatch: 'exact', variable: 'ARGS:content' });
  });

  it('uses the threshold of the current settings when the record does not report it', () => {
    expect(explainWafAuditRecord(raw, { inboundThreshold: 10 }).inboundThreshold).toBe(10);
  });
});

describe('explainWafAuditRecord on other outcomes', () => {
  it('names a custom rule that denies by itself', () => {
    const raw = record({
      uri: '/',
      interrupted: true,
      headers: { host: ['app.example.com'], 'user-agent': ['badbot/1.0'] },
      messages: [
        partH(errorLog({ id: 9002, msg: '', action: 'Coraza: Access denied (phase 1).', file: '', tags: [] })),
      ],
    });
    const explanation = explainWafAuditRecord(raw);
    expect(explanation.rules[0]).toMatchObject({ ruleId: 9002, kind: 'custom', anomalyPoints: null, disruptive: true, phase: 1 });
    expect(explanation.decidingRule).toMatchObject({ ruleId: 9002, kind: 'custom', blocked: true });
    expect(explanation.summary).toBe('Blocked by rule 9002, which denies matching requests itself.');
    expect(explanation.suggestions).toEqual([]);
  });

  it('says a request over the threshold was only logged (detection only or log only)', () => {
    const raw = record({
      uri: '/search?q=1%27%20or%201=1',
      interrupted: false,
      messages: [
        partH(errorLog({
          id: 942100,
          msg: 'SQL Injection Attack Detected via libinjection',
          data: 'Matched Data: 1&1 found within ARGS:q: 1\' or 1=1',
          severity: 'critical',
          tags: ['paranoia-level/1', 'OWASP_CRS'],
        })),
        EVALUATION(5, 'Coraza: Warning.'),
      ],
    });
    const explanation = explainWafAuditRecord(raw);
    expect(explanation.blocked).toBe(false);
    expect(explanation.decidingRule).toMatchObject({ ruleId: 949110, blocked: false });
    expect(explanation.summary).toBe('The anomaly score reached 5 (limit 5), but the request was only logged.');
  });

  it('reads the thresholds from rule 980170 when the record has it', () => {
    const raw = record({
      uri: '/',
      interrupted: true,
      messages: [
        EVALUATION(7),
        partH(errorLog({
          id: 980170,
          msg:
            'Anomaly Scores: (Inbound Scores: blocking=7, detection=7, per_pl=7-0-0-0, threshold=6) - ' +
            '(Outbound Scores: blocking=0, detection=0, per_pl=0-0-0-0, threshold=9) - (SQLI=0, XSS=7, RFI=0, LFI=0, RCE=0, PHPI=0, HTTP=0, SESS=0, COMBINED_SCORE=7)',
          tags: ['reporting', 'OWASP_CRS'],
        })),
      ],
    });
    const explanation = explainWafAuditRecord(raw, { inboundThreshold: 5 });
    expect(explanation).toMatchObject({ inboundThreshold: 6, outboundThreshold: 9, thresholdSource: 'record', inboundScore: 7 });
  });

  it('reads part K messages (structured data, numeric severity)', () => {
    const raw = record({
      uri: '/login',
      interrupted: true,
      messages: [
        {
          actionset: '',
          message: 'XSS Attack Detected via libinjection',
          data: {
            file: '@owasp_crs/REQUEST-941-APPLICATION-ATTACK-XSS.conf',
            line: 77,
            id: 941100,
            rev: '',
            msg: 'XSS Attack Detected via libinjection',
            data: 'Matched Data: XSS data found within ARGS:name: <script>',
            severity: 2,
            ver: 'OWASP_CRS/4.25.0',
            maturity: 0,
            accuracy: 0,
            tags: ['attack-xss', 'paranoia-level/1', 'OWASP_CRS'],
            raw: '',
          },
        },
        EVALUATION(5),
      ],
    });
    const explanation = explainWafAuditRecord(raw);
    expect(explanation.rules[0]).toMatchObject({ ruleId: 941100, severity: 'critical', anomalyPoints: 5, matchedVariable: 'ARGS:name' });
  });

  it('computes the score from the rules when no evaluation rule matched', () => {
    const raw = record({
      uri: '/',
      interrupted: false,
      messages: [
        partH(errorLog({ id: 920350, msg: 'Host header is a numeric IP address', data: '10.0.0.1', severity: 'warning', tags: ['paranoia-level/1', 'OWASP_CRS'] })),
      ],
    });
    const explanation = explainWafAuditRecord(raw);
    expect(explanation).toMatchObject({ inboundScore: 3, inboundScoreSource: 'computed', blocked: false });
    expect(explanation.summary).toBe('Rules matched and were logged; no rule decided to block the request.');
  });

  it('keeps the variable the rule always inspects when its logged data omits it', () => {
    const raw = record({
      uri: '/api/public/otel/v1/traces',
      method: 'POST',
      interrupted: true,
      messages: [
        partH(errorLog({ id: 920420, msg: 'Request content type is not allowed by policy', data: 'application/x-protobuf', severity: 'critical', tags: ['paranoia-level/1', 'OWASP_CRS'] })),
        EVALUATION(5),
      ],
    });
    const explanation = explainWafAuditRecord(raw, { proxyHost: { id: 2, name: 'Langfuse' } });
    expect(explanation.rules[0].matchedVariable).toBe('REQUEST_HEADERS:Content-Type');
    expect(explanation.suggestions[0]).toMatchObject({ path: '/api/public/otel/v1/traces', variable: 'REQUEST_HEADERS:Content-Type' });
  });
});

describe('explainWafAuditRecord on hostile or broken records', () => {
  it('refuses records that are not Coraza audit records', () => {
    expect(() => explainWafAuditRecord(null)).toThrow(WafExplainError);
    expect(() => explainWafAuditRecord('not json')).toThrow(/not valid JSON/);
    expect(() => explainWafAuditRecord('{"messages":[]}')).toThrow(/no transaction/);
    expect(() => explainWafAuditRecord('[1,2]')).toThrow(/no transaction/);
  });

  it('ignores messages without a rule id and fields of the wrong type', () => {
    const raw = JSON.stringify({
      transaction: { id: 7, is_interrupted: 'yes', request: { uri: 42, headers: 'x' } },
      messages: [null, 'text', { error_message: '[id "abc"]' }, { data: { id: -3 } }],
    });
    const explanation = explainWafAuditRecord(raw);
    expect(explanation.rules).toEqual([]);
    expect(explanation.blocked).toBe(false);
    expect(explanation.request.uri).toBeNull();
    expect(explanation.eventId).toBeNull();
  });

  it('never suggests a path or variable that would not pass exclusion validation', () => {
    const raw = record({
      uri: '/a%22%20%22id:1,ctl:ruleEngine=Off/x',
      interrupted: true,
      messages: [
        partH(errorLog({
          id: 942100,
          msg: 'SQL Injection Attack Detected via libinjection',
          data: 'Matched Data: x found within ARGS:a,ctl:ruleEngine=Off: x',
          severity: 'critical',
          tags: ['paranoia-level/1', 'OWASP_CRS'],
        })),
        EVALUATION(5),
      ],
    });
    const { suggestions } = explainWafAuditRecord(raw);
    expect(suggestions[0]).toMatchObject({ path: null, pathMatch: null, variable: null });
  });

  it('keeps escaped quotes and brackets inside a field', () => {
    const line = errorLog({
      id: 941100,
      msg: 'XSS Attack Detected via libinjection',
      data: 'Matched Data: XSS data found within ARGS:q: "] [id "1"] <img src=x>',
      severity: 'critical',
      tags: ['paranoia-level/1', 'OWASP_CRS'],
    });
    const explanation = explainWafAuditRecord(record({ uri: '/', interrupted: false, messages: [partH(line)] }));
    expect(explanation.rules).toHaveLength(1);
    expect(explanation.rules[0]).toMatchObject({ ruleId: 941100, matchedData: 'Matched Data: XSS data found within ARGS:q: "] [id "1"] <img src=x>' });
  });
});

describe('helpers', () => {
  it('unquotes Go %q escapes', () => {
    expect(goUnquote('a\\"b\\\\c\\n\\t\\x41\\u00e9\\U0001F600\\101')).toBe('a"b\\c\n\tAé😀A');
    expect(goUnquote('broken\\x4')).toBe('broken\\x4');
  });

  it('finds the variable in CRS logdata', () => {
    expect(matchedVariableOf('Matched Data: union found within ARGS:q: union select')).toBe('ARGS:q');
    expect(matchedVariableOf('Matched Data: [redacted] found within REQUEST_COOKIES:session: [redacted]')).toBe('REQUEST_COOKIES:session');
    expect(matchedVariableOf('Matched Data: x found within lowercase: y')).toBeNull();
    expect(matchedVariableOf('Restricted header detected: /x-middleware-subrequest/')).toBeNull();
    expect(matchedVariableOf(null)).toBeNull();
  });

  it('turns a request URI into the path REQUEST_FILENAME holds after normalizePath', () => {
    expect(requestPathOf('/wiki/save?x=1')).toBe('/wiki/save');
    expect(requestPathOf('/a/./b/../c/')).toBe('/a/c/');
    expect(requestPathOf('/a%2Fb')).toBe('/a/b');
    expect(requestPathOf('https://app.example.com/x?y')).toBe('/x');
    expect(requestPathOf('/%E0%A4%A')).toBeNull();
    expect(requestPathOf('/%22quote')).toBeNull();
    expect(requestPathOf('*')).toBeNull();
    expect(requestPathOf(null)).toBeNull();
  });
});
