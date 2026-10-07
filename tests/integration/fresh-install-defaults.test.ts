/**
 * A fresh install routes and terminates TLS only: every optional protection
 * and every optional sign-in or fleet feature is off or empty until an
 * administrator sets it up. The WAF, access lists, blocked sources, geo
 * blocking, rate limiting, the sign-in portal, client certificates and
 * instance sync are optional (README.md, "Features").
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import {
  settings,
  proxyHosts,
  accessLists,
  accessListEntries,
  accessListRules,
  caCertificates,
  issuedClientCertificates,
  mtlsAccessRules,
  forwardAuthAccess,
  instances,
  fleetInstances,
  fleetPullReplicas,
  wafRuleExclusions,
} from '@/src/lib/db/schema';

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
});

type Table = Parameters<ReturnType<TestDb['select']>['from']>[0];

async function count(table: Table): Promise<number> {
  const rows = await db.select().from(table);
  return rows.length;
}

describe('fresh install defaults', () => {
  it('stores no WAF, geo blocking, rate limiting, forward-auth server or instance mode setting', async () => {
    const keys = ['waf', 'geoblock', 'rate_limit', 'forward_auth', 'authentik', 'instance_mode'];
    const rows = await db.select().from(settings).where(inArray(settings.key, keys));
    expect(rows.map((row) => row.key)).toEqual([]);
  });

  it('has no proxy host, so no host with the WAF, the sign-in portal or mutual TLS turned on', async () => {
    expect(await count(proxyHosts)).toBe(0);
    expect(await count(forwardAuthAccess)).toBe(0);
    expect(await count(wafRuleExclusions)).toBe(0);
  });

  it('has no access list, no blocked sources list and no rules', async () => {
    expect(await count(accessLists)).toBe(0);
    expect(await count(accessListEntries)).toBe(0);
    expect(await count(accessListRules)).toBe(0);
  });

  it('has no certificate authority and no client certificate', async () => {
    expect(await count(caCertificates)).toBe(0);
    expect(await count(issuedClientCertificates)).toBe(0);
    expect(await count(mtlsAccessRules)).toBe(0);
  });

  it('has no instance sync or fleet configuration', async () => {
    expect(await count(instances)).toBe(0);
    expect(await count(fleetInstances)).toBe(0);
    expect(await count(fleetPullReplicas)).toBe(0);
  });
});
