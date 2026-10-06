/**
 * Synthetic data for the website screenshots: host names on example.com and
 * example.org, client addresses only from the documentation ranges
 * (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32), AS numbers
 * only from the documentation range 64496–64511 with made-up names, and
 * OWASP Core Rule Set rule ids. Everything is generated from a fixed seed,
 * so every run draws the same picture (shifted to the time it runs).
 */
import { userAgentFamily } from '../../src/lib/analytics/user-agent';

/** A small deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted<T>(entries: readonly (readonly [T, number])[], random: () => number): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let pick = random() * total;
  for (const [value, weight] of entries) {
    pick -= weight;
    if (pick < 0) return value;
  }
  return entries[entries.length - 1][0];
}

/** An array of 100 values in proportion to their weights (the SQL picks one with `rand() % 100 + 1`). */
function hundred<T>(entries: readonly (readonly [T, number])[]): T[] {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const out: T[] = [];
  for (const [value, weight] of entries) {
    const n = Math.round((weight / total) * 100);
    for (let i = 0; i < n; i++) out.push(value);
  }
  while (out.length < 100) out.push(entries[0][0]);
  return out.slice(0, 100);
}

// ── Proxy hosts ─────────────────────────────────────────────────────────────

export type ShotHost = {
  key: string;
  name: string;
  domains: string[];
  upstreams: string[];
  tags: string[];
  /** Share of the traffic, in percent. */
  traffic: number;
  paths: string[];
};

export const HOSTS: ShotHost[] = [
  {
    key: 'shop',
    name: 'Shop',
    domains: ['shop.example.com', 'www.shop.example.com'],
    upstreams: ['http://192.0.2.10:8080', 'http://192.0.2.11:8080', 'http://192.0.2.12:8080'],
    tags: ['shop', 'production'],
    traffic: 27,
    paths: [
      '/', '/', '/products', '/products/linen-shirt', '/products/espresso-cups', '/products/desk-lamp', '/products/wool-scarf',
      '/cart', '/checkout', '/account', '/search', '/static/app.3f9c1b.js', '/static/app.3f9c1b.css', '/images/hero.webp', '/favicon.ico',
    ],
  },
  {
    key: 'api',
    name: 'Shop API',
    domains: ['api.example.com'],
    upstreams: ['http://192.0.2.20:9000', 'http://192.0.2.21:9000'],
    tags: ['shop', 'api', 'production'],
    traffic: 24,
    paths: ['/v2/products', '/v2/products/1042', '/v2/cart', '/v2/orders', '/v2/orders/88213', '/v2/auth/token', '/v2/search', '/v2/inventory', '/healthz'],
  },
  {
    key: 'www',
    name: 'Website',
    domains: ['www.example.com', 'example.com'],
    upstreams: ['http://192.0.2.30:80'],
    tags: ['marketing'],
    traffic: 16,
    paths: ['/', '/', '/about', '/blog', '/blog/autumn-collection', '/pricing', '/contact', '/robots.txt', '/sitemap.xml', '/assets/site.css', '/assets/logo.svg'],
  },
  {
    key: 'docs',
    name: 'Developer docs',
    domains: ['docs.example.org'],
    upstreams: ['http://192.0.2.40:3000'],
    tags: ['docs'],
    traffic: 10,
    paths: ['/', '/getting-started', '/api/reference', '/api/reference/orders', '/guides/webhooks', '/search', '/assets/docs.js'],
  },
  {
    key: 'portal',
    name: 'Customer portal',
    domains: ['portal.example.com'],
    upstreams: ['http://192.0.2.50:8000'],
    tags: ['internal'],
    traffic: 8,
    paths: ['/', '/dashboard', '/invoices', '/invoices/2026-09', '/settings', '/api/session'],
  },
  {
    key: 'status',
    name: 'Status page',
    domains: ['status.example.org'],
    upstreams: ['http://192.0.2.60:8080'],
    tags: ['marketing'],
    traffic: 7,
    paths: ['/', '/api/v1/status', '/history', '/feed.rss'],
  },
  {
    key: 'hooks',
    name: 'Webhooks',
    domains: ['hooks.example.com'],
    upstreams: ['http://192.0.2.70:7000'],
    tags: ['api', 'production'],
    traffic: 5,
    paths: ['/payments', '/repository', '/healthz'],
  },
  {
    key: 'grafana',
    name: 'Grafana',
    domains: ['grafana.example.org'],
    upstreams: ['http://192.0.2.80:3000'],
    tags: ['internal', 'monitoring'],
    traffic: 2,
    paths: ['/', '/d/overview', '/api/dashboards/uid/overview', '/login', '/public/build/app.js'],
  },
  {
    key: 'crm',
    name: 'Legacy CRM',
    domains: ['crm.example.org'],
    upstreams: ['http://192.0.2.90:8080'],
    tags: ['internal'],
    traffic: 1,
    paths: ['/', '/login', '/contacts', '/api/contacts'],
  },
];

// ── Networks and countries ─────────────────────────────────────────────────

export const AS_NAMES: Record<number, string> = {
  64496: 'Example Fibre',
  64497: 'Example Telecom',
  64498: 'Example Mobile',
  64499: 'Example Broadband',
  64500: 'Example Cable',
  64501: 'Example Cloud',
  64502: 'Example Datacenter',
  64503: 'Example University Network',
  64504: 'Example Metro Net',
  64505: 'Example Wireless',
  64506: 'Example Business Lines',
  64510: 'Example Hosting',
  64511: 'Example VPS',
};

const POPULATION_COUNTRIES = [
  ['IT', 28], ['DE', 14], ['US', 12], ['FR', 8], ['GB', 7], ['NL', 6], ['ES', 5], ['CH', 4], ['AT', 3], ['PL', 3],
  ['SE', 2], ['BE', 2], ['IE', 1], ['PT', 1], ['BR', 1], ['IN', 1], ['JP', 1], ['CA', 1],
] as const;
const POPULATION_ASNS = [
  [64496, 18], [64497, 16], [64498, 14], [64499, 12], [64500, 8], [64501, 7], [64502, 5], [64503, 4], [64504, 6], [64505, 6], [64506, 4],
] as const;

type Client = { ip: string; country: string; asn: number };

function populationIp(index: number): string {
  if (index < 254) return `198.51.100.${index + 1}`;
  if (index < 508) return `192.0.2.${index - 253}`;
  if (index < 600) return `203.0.113.${index - 507}`;
  return `2001:db8:${(0x1000 + index * 37).toString(16)}::${index.toString(16)}`;
}

/** 700 regular visitors; the first ones are the busiest (the SQL skews towards low indexes). */
export const POPULATION: Client[] = (() => {
  const random = prng(7);
  return Array.from({ length: 700 }, (_, index) => ({
    ip: populationIp(index),
    country: weighted(POPULATION_COUNTRIES, random),
    asn: weighted(POPULATION_ASNS, random),
  }));
})();

/** 70 addresses stopped by geo and network rules (countries and the AS the global rules block). */
export const GEO_BLOCKED: Client[] = (() => {
  const random = prng(11);
  return Array.from({ length: 70 }, (_, i) => {
    const asnRule = random() < 0.2;
    return {
      ip: `203.0.113.${100 + i}`,
      country: asnRule ? 'NL' : weighted([['CN', 5], ['RU', 4], ['VN', 1]] as const, random),
      asn: asnRule ? 64511 : weighted([[64501, 1], [64502, 1], [64504, 1]] as const, random),
    };
  });
})();

/** 70 addresses behind the background noise of scanners and probes the WAF stops. */
export const WAF_NOISE: Client[] = (() => {
  const random = prng(13);
  return Array.from({ length: 70 }, (_, i) => ({
    ip: `203.0.113.${170 + i}`,
    country: weighted([['US', 4], ['NL', 2], ['DE', 2], ['SG', 1], ['FR', 1], ['GB', 1]] as const, random),
    asn: weighted([[64510, 3], [64511, 2], [64502, 2], [64501, 1]] as const, random),
  }));
})();

/** The addresses behind the WAF burst of the last few hours. */
export const BURST: Client[] = [
  { ip: '203.0.113.240', country: 'NL', asn: 64510 },
  { ip: '203.0.113.241', country: 'NL', asn: 64510 },
  { ip: '203.0.113.242', country: 'US', asn: 64511 },
  { ip: '2001:db8:bad:1::17', country: 'US', asn: 64511 },
];

// ── User agents ────────────────────────────────────────────────────────────

const USER_AGENTS = [
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 25],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', 18],
  ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 12],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15', 9],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 8],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0', 7],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 5],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0', 2],
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 3],
  ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 1],
  ['okhttp/4.12.0', 4],
  ['curl/8.5.0', 2],
  ['python-requests/2.32.3', 2],
  ['Go-http-client/2.0', 2],
] as const;

export const UA_STRINGS: string[] = USER_AGENTS.map(([ua]) => ua);
export const UA_FAMILIES: string[] = UA_STRINGS.map((ua) => userAgentFamily(ua));
/** 100 one-based indexes into UA_STRINGS, in proportion to their weights. */
export const UA_PICK: number[] = hundred(USER_AGENTS.map(([, weight], i) => [i + 1, weight] as const));
/** okhttp: the shop's mobile app, most of the API's traffic. */
export const UA_APP = UA_STRINGS.indexOf('okhttp/4.12.0') + 1;

export const ATTACK_USER_AGENTS = ['sqlmap/1.8.9#stable (https://sqlmap.org)', 'python-requests/2.32.3', 'Mozilla/5.0 (compatible; Nmap Scripting Engine; https://nmap.org/book/nse.html)', 'Go-http-client/1.1'];
export const ATTACK_UA_FAMILIES = ATTACK_USER_AGENTS.map((ua) => userAgentFamily(ua));

// ── WAF rules (OWASP Core Rule Set 4) ─────────────────────────────────────

export const CRS_RULES: Record<number, { message: string; severity: string }> = {
  942100: { message: 'SQL Injection Attack Detected via libinjection', severity: 'critical' },
  942190: { message: 'Detects MSSQL code execution and information gathering attempts', severity: 'critical' },
  941100: { message: 'XSS Attack Detected via libinjection', severity: 'critical' },
  930120: { message: 'OS File Access Attempt', severity: 'critical' },
  930110: { message: 'Path Traversal Attack (/../) or (/.. )', severity: 'critical' },
  932160: { message: 'Remote Command Execution: Unix Shell Code Found', severity: 'critical' },
  933160: { message: 'PHP Injection Attack: High-Risk PHP Function Call Found', severity: 'critical' },
  913100: { message: 'Found User-Agent associated with security scanner', severity: 'critical' },
  920350: { message: 'Host header is a numeric IP address', severity: 'warning' },
  920440: { message: 'URL file extension is restricted by policy', severity: 'critical' },
  920300: { message: 'Request Missing an Accept Header', severity: 'notice' },
  920320: { message: 'Missing User Agent Header', severity: 'notice' },
};

/** Request paths of the burst's attacks, the rule that stops each and its share in percent (mostly SQL injection on one page, as sqlmap does). */
export const ATTACKS: [string, number, number][] = [
  ["/products?id=1'%20OR%20'1'='1", 942100, 34],
  ['/products?id=1;EXEC%20xp_cmdshell(%27dir%27)', 942190, 21],
  ['/search?q=1%20UNION%20SELECT%20username,password%20FROM%20users--', 942100, 3],
  ['/search?q=%3Cscript%3Ealert(document.cookie)%3C/script%3E', 941100, 2],
  ['/account?next=javascript:alert(1)//%3Csvg/onload=alert(1)%3E', 941100, 7],
  ['/static/../../../../etc/passwd', 930120, 7],
  ['/download?file=..%2F..%2F..%2Fetc%2Fshadow', 930110, 7],
  ['/cgi-bin/status?cmd=;cat%20/etc/passwd', 932160, 7],
  ['/index.php?page=system(%27id%27)', 933160, 6],
  ['/.env.bak', 920440, 6],
];

/** Paths the background scanners try. */
export const PROBES: [string, number][] = [
  ['/wp-login.php', 913100],
  ['/.env', 930120],
  ['/.git/config', 930120],
  ['/phpmyadmin/index.php', 913100],
  ['/config.php.bak', 920440],
  ['/vendor/phpunit/src/Util/PHP/eval-stdin.php', 933160],
  ["/?id=1'%20AND%201=1", 942100],
  ['/admin/backup.sql', 920440],
];

// ── ClickHouse ─────────────────────────────────────────────────────────────

export const DAY = 86_400;

/** Query parameters shared by the traffic SQL below. */
export function trafficParams(now: number) {
  const hostPick = hundred(HOSTS.map((host, i) => [i + 1, host.traffic] as const));
  const asnIds = Object.keys(AS_NAMES).map(Number);
  return {
    now,
    hosts: HOSTS.map((host) => host.domains[0]),
    host_pick: hostPick,
    paths: HOSTS.map((host) => host.paths),
    pop_ip: POPULATION.map((c) => c.ip),
    pop_country: POPULATION.map((c) => c.country),
    pop_asn: POPULATION.map((c) => c.asn),
    geo_ip: GEO_BLOCKED.map((c) => c.ip),
    geo_country: GEO_BLOCKED.map((c) => c.country),
    geo_asn: GEO_BLOCKED.map((c) => c.asn),
    noise_ip: WAF_NOISE.map((c) => c.ip),
    noise_country: WAF_NOISE.map((c) => c.country),
    noise_asn: WAF_NOISE.map((c) => c.asn),
    asn_ids: asnIds,
    asn_names: asnIds.map((id) => AS_NAMES[id]),
    ua: UA_STRINGS,
    ua_family: UA_FAMILIES,
    ua_pick: UA_PICK,
    ua_app: UA_APP,
    attack_ua: ATTACK_USER_AGENTS,
    attack_ua_family: ATTACK_UA_FAMILIES,
    probe_path: PROBES.map(([path]) => path),
    probe_rule: PROBES.map(([, rule]) => rule),
  };
}

const COLUMNS = 'ts, client_ip, country_code, host, method, uri, status, proto, bytes_sent, user_agent, is_blocked, is_rate_limited, asn, as_org, outcome, duration_ms, ua_family, waf_rule_id';

/**
 * Regular traffic of the last `span` seconds, sampled from `n` draws: a daily
 * rhythm (quietest at 03:30 UTC, busiest mid-afternoon), a little growth
 * over the two weeks, and the usual mix of outcomes:
 * background WAF and geo blocks everywhere, rate limits on the API,
 * sign-in redirects on the portal, basic auth on the internal hosts, and a
 * 502 episode on the API a few hours ago.
 */
export const TRAFFIC_SQL = `
INSERT INTO traffic_events (${COLUMNS})
SELECT ts, client_ip, country_code, host, method, uri, status, proto, bytes_sent, user_agent,
       outcome IN ('geo', 'access') AS is_blocked, outcome = 'rate_limit' AS is_rate_limited,
       asn, as_org, outcome, duration_ms, ua_family, waf_rule_id
FROM (
  SELECT
    toDateTime({now:UInt32} - (rand(1) % {span:UInt32})) AS ts,
    toFloat64(toHour(ts, 'UTC')) + toMinute(ts, 'UTC') / 60.0 AS hod,
    (0.3 + 0.7 * pow(sin(pi() * (hod - 3.5) / 24), 2))
      * (1.0 - 0.1 * ({now:UInt32} - toUInt32(ts)) / {span:UInt32})
      * (0.92 + (cityHash64(toStartOfHour(ts)) % 17) / 100.0) AS weight,
    rand(2) AS r_ip, rand(3) AS r_host, rand(4) AS r_out, rand(5) AS r_path, rand(6) AS r_st, rand(7) AS r_ua, rand(8) AS r_b, rand(9) AS r_keep, rand(10) AS r_m,
    {host_pick:Array(UInt8)}[r_host % 100 + 1] AS hi,
    {hosts:Array(String)}[hi] AS host,
    r_out % 10000 AS o,
    multiIf(o < 55, 'waf', o < 110, 'geo',
            host = 'api.example.com' AND o < 230, 'rate_limit',
            host IN ('grafana.example.org', 'crm.example.org') AND o < 500, 'access',
            host = 'portal.example.com' AND o < 230, 'auth',
            'served') AS outcome,
    toUInt32(floor(pow(r_ip / 4294967296.0, 2.4) * 700)) + 1 AS pi_,
    r_ip % 70 + 1 AS hx,
    multiIf(outcome = 'geo', {geo_ip:Array(String)}[hx], outcome = 'waf', {noise_ip:Array(String)}[hx], {pop_ip:Array(String)}[pi_]) AS client_ip,
    multiIf(outcome = 'geo', {geo_country:Array(String)}[hx], outcome = 'waf', {noise_country:Array(String)}[hx], {pop_country:Array(String)}[pi_]) AS country_code,
    multiIf(outcome = 'geo', {geo_asn:Array(UInt32)}[hx], outcome = 'waf', {noise_asn:Array(UInt32)}[hx], {pop_asn:Array(UInt32)}[pi_]) AS asn,
    transform(asn, {asn_ids:Array(UInt32)}, {asn_names:Array(String)}, '') AS as_org,
    r_path % ${PROBES.length} + 1 AS pr,
    if(outcome = 'waf', {probe_path:Array(String)}[pr], arrayElement({paths:Array(Array(String))}[hi], r_path % length({paths:Array(Array(String))}[hi]) + 1)) AS uri,
    if(outcome = 'waf', {probe_rule:Array(UInt32)}[pr], 0) AS waf_rule_id,
    r_st % 10000 AS st,
    multiIf(outcome IN ('waf', 'geo'), 403, outcome = 'rate_limit', 429, outcome = 'access', 401, outcome = 'auth', 302,
            host = 'api.example.com' AND ts BETWEEN toDateTime({now:UInt32} - 6 * 3600 - 1500) AND toDateTime({now:UInt32} - 6 * 3600) AND st < 3800, 502,
            st < 20, 500, st < 45, 502, st < 55, 503, st < 520, 404, st < 1150, 304, st < 1300, 301,
            host = 'api.example.com' AND st < 1600, 401, 200) AS status,
    r_m % 1000 AS m,
    multiIf(host = 'hooks.example.com' AND m < 900, 'POST', host = 'api.example.com' AND m < 280, 'POST', m < 60, 'POST', m < 80, 'HEAD',
            m < 88, 'OPTIONS', host = 'api.example.com' AND m < 320, 'PUT', host = 'api.example.com' AND m < 335, 'DELETE', 'GET') AS method,
    multiIf(outcome = 'waf', r_ua % ${ATTACK_USER_AGENTS.length} + 1 + 1000,
            host = 'api.example.com' AND r_ua % 3 = 0, {ua_app:UInt8},
            {ua_pick:Array(UInt8)}[r_ua % 100 + 1]) AS uai,
    if(uai > 1000, {attack_ua:Array(String)}[uai - 1000], {ua:Array(String)}[uai]) AS user_agent,
    if(uai > 1000, {attack_ua_family:Array(String)}[uai - 1000], {ua_family:Array(String)}[uai]) AS ua_family,
    multiIf(r_b % 100 < 66, 'HTTP/2.0', r_b % 100 < 91, 'HTTP/1.1', 'HTTP/3.0') AS proto,
    multiIf(status = 304 OR status = 302 OR status = 301, 0,
            status >= 400 AND status < 500, 120 + r_b % 900,
            status >= 500, 40 + r_b % 300,
            endsWith(uri, '.js') OR endsWith(uri, '.css') OR endsWith(uri, '.webp'), 18000 + r_b % 360000,
            600 + r_b % 46000) AS bytes_sent,
    toUInt32(multiIf(outcome != 'served', r_b % 3,
                     status = 502, 2 + r_b % 30,
                     4 + pow((r_b % 10000) / 10000.0, 3) * 900)) AS duration_ms
  FROM numbers({n:UInt64})
)
WHERE (r_keep % 10000) < weight * 10000
`;

/**
 * The WAF burst: four addresses trying SQL injection, XSS, path traversal
 * and command injection against the shop and its API for about 40 minutes,
 * starting `ago` seconds before now; all stopped by the WAF.
 */
export const BURST_SQL = `
INSERT INTO traffic_events (${COLUMNS})
SELECT ts, client_ip, country_code, host, method, uri, 403 AS status, 'HTTP/1.1' AS proto, 120 + rand(1) % 600 AS bytes_sent,
       user_agent, false AS is_blocked, false AS is_rate_limited, asn, as_org, 'waf' AS outcome, rand(2) % 3 AS duration_ms, ua_family, waf_rule_id
FROM (
  SELECT
    toDateTime({start:UInt32} + intDiv(number * {duration:UInt32}, {n:UInt32}) + rand(3) % 7) AS ts,
    number % length({ips:Array(String)}) + 1 AS ci,
    {ips:Array(String)}[ci] AS client_ip,
    {countries:Array(String)}[ci] AS country_code,
    {asns:Array(UInt32)}[ci] AS asn,
    {as_orgs:Array(String)}[ci] AS as_org,
    if(cityHash64(number, 4) % 10 < 9, 'shop.example.com', 'api.example.com') AS host,
    {pick:Array(UInt8)}[(number * 37) % 100 + 1] AS ai,
    {paths:Array(String)}[ai] AS uri,
    {rules:Array(UInt32)}[ai] AS waf_rule_id,
    if(rand(6) % 4 = 0, 'POST', 'GET') AS method,
    {uas:Array(String)}[ci % length({uas:Array(String)}) + 1] AS user_agent,
    {ua_families:Array(String)}[ci % length({ua_families:Array(String)}) + 1] AS ua_family
  FROM numbers({n:UInt32})
)
`;

/**
 * One WAF event for every request the WAF stopped (the first specific rule, as the log parser stores it).
 * The SQL injection events carry a Coraza audit record (sqliRecord), so the event detail can say why
 * each was blocked and offer an exclusion; the others have none, like events logged without one.
 */
export const WAF_EVENTS_SQL = `
INSERT INTO waf_events (ts, host, client_ip, country_code, method, uri, rule_id, rule_message, severity, raw_data, blocked, tx_id)
SELECT ts, host, client_ip, country_code, method, uri, toInt32(waf_rule_id),
       transform(waf_rule_id, {rule_ids:Array(UInt32)}, {rule_messages:Array(String)}, ''),
       transform(waf_rule_id, {rule_ids:Array(UInt32)}, {rule_severities:Array(String)}, 'critical'),
       nullIf(replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(
         transform(uri, {sqli_paths:Array(String)}, {sqli_records:Array(String)}, ''),
         '__TX__', tx), '__HOST__', host), '__CLIENT__', client_ip), '__METHOD__', method),
         '__NS__', concat(toString(toUnixTimestamp(ts)), '000000000')), ''),
       true, tx
FROM (
  SELECT *, lower(hex(cityHash64(ts, client_ip, uri, host, rand()))) AS tx
  FROM traffic_events
  WHERE outcome = 'waf' AND waf_rule_id != 0
)
`;

/** The argument and value a SQL injection path attacks: ARGS:id, 1' OR '1'='1. */
function sqliArgument(path: string): { name: string; value: string } {
  const query = path.slice(path.indexOf('?') + 1);
  const [name, raw] = query.split(/=(.*)/s);
  return { name, value: decodeURIComponent(raw) };
}

/**
 * The Coraza audit record (SecAuditLogParts ABFHZ, as coraza-caddy writes it) of a blocked SQL injection
 * request: rule 942100 matched, then the inbound anomaly score blocked it. __TX__, __HOST__, __CLIENT__,
 * __METHOD__ and __NS__ are filled in per event by WAF_EVENTS_SQL.
 */
export function sqliRecord(path: string): string {
  const arg = sqliArgument(path);
  const q = (value: string) => JSON.stringify(value);
  const line = (action: string, id: number, msg: string, data: string, severity: string, file: string) =>
    `[client "__CLIENT__"] ${action} ${msg} [file ${q(file)}] [line "4242"] [id ${q(String(id))}] [rev ""] ` +
    `[msg ${q(msg)}] [data ${q(data)}] [severity ${q(severity)}] [ver "OWASP_CRS/4.25.0"] [maturity "0"] [accuracy "0"] ` +
    `[tag "attack-sqli"] [hostname "172.18.0.5"] [uri ${q(path)}] [unique_id "__TX__"]`;
  const partH = (error: string) => ({ actionset: '', message: '', error_message: error, data: null });
  return JSON.stringify({
    transaction: {
      timestamp: '',
      unix_timestamp: '__NS__',
      id: '__TX__',
      client_ip: '__CLIENT__',
      client_port: 51234,
      host_ip: '172.18.0.5',
      host_port: 443,
      server_id: '',
      request: {
        method: '__METHOD__',
        protocol: 'HTTP/2.0',
        uri: path,
        http_version: '2.0',
        headers: { host: ['__HOST__'], 'user-agent': ['sqlmap/1.8.4#stable (https://sqlmap.org)'] },
        body: '',
        files: null,
        args: {},
        length: 0,
      },
      response: { protocol: '', status: 403, headers: {}, body: '' },
      producer: { connector: 'coraza-caddy', version: 'v2.6.1', server: '', rule_engine: 'On', stopwatch: '', rulesets: ['OWASP_CRS/4.25.0'] },
      highest_severity: '',
      is_interrupted: true,
    },
    messages: [
      partH(line('Coraza: Warning.', 942100, 'SQL Injection Attack Detected via libinjection',
        `Matched Data: s&sos found within ARGS:${arg.name}: ${arg.value}`, 'CRITICAL', '@owasp_crs/REQUEST-942-APPLICATION-ATTACK-SQLI.conf')),
      partH(line('Coraza: Access denied (phase 2).', 949110, 'Inbound Anomaly Score Exceeded (Total Score: 5)',
        '', 'unknown', '@owasp_crs/REQUEST-949-BLOCKING-EVALUATION.conf')),
    ],
  }).replace('"__NS__"', '__NS__');
}

/**
 * Matches that stay below the anomaly threshold (protocol notices and
 * warnings): logged, not blocked, on about one in 500 requests.
 */
export const DETECTIONS_SQL = `
INSERT INTO waf_events (ts, host, client_ip, country_code, method, uri, rule_id, rule_message, severity, raw_data, blocked, tx_id)
SELECT ts, host, client_ip, country_code, method, uri, toInt32(rule), transform(rule, {rule_ids:Array(UInt32)}, {rule_messages:Array(String)}, ''),
       transform(rule, {rule_ids:Array(UInt32)}, {rule_severities:Array(String)}, 'warning'), NULL, false, lower(hex(cityHash64(ts, client_ip, uri, host, rand())))
FROM (
  SELECT ts, host, client_ip, country_code, method, uri, [920350, 920300, 920320][cityHash64(ts, client_ip) % 3 + 1] AS rule
  FROM traffic_events
  WHERE outcome = 'served' AND cityHash64(ts, client_ip, uri) % 500 = 0
)
`;

export function ruleParams() {
  const ids = Object.keys(CRS_RULES).map(Number);
  const sqliPaths = [...new Set([...ATTACKS, ...PROBES].filter(([, rule]) => rule === 942100).map(([path]) => path))];
  return {
    rule_ids: ids,
    rule_messages: ids.map((id) => CRS_RULES[id].message),
    rule_severities: ids.map((id) => CRS_RULES[id].severity),
    sqli_paths: sqliPaths,
    sqli_records: sqliPaths.map(sqliRecord),
  };
}

export function burstParams(start: number) {
  return {
    start,
    duration: 38 * 60,
    n: 700,
    ips: BURST.map((c) => c.ip),
    countries: BURST.map((c) => c.country),
    asns: BURST.map((c) => c.asn),
    as_orgs: BURST.map((c) => AS_NAMES[c.asn]),
    paths: ATTACKS.map(([path]) => path),
    rules: ATTACKS.map(([, rule]) => rule),
    pick: hundred(ATTACKS.map(([, , share], i) => [i + 1, share] as const)),
    uas: ATTACK_USER_AGENTS.slice(0, 2),
    ua_families: ATTACK_UA_FAMILIES.slice(0, 2),
  };
}
