/**
 * What the Access lists pages say about a list (app/(dashboard)/access-lists/access-list-view.ts):
 * the plain-language summary, the warnings and the searches.
 */
import { describe, expect, it } from 'vitest';
import {
  describeAccessList,
  describeRules,
  describeSources,
  joinAnd,
  listWarning,
  matchesBlockedSearch,
  matchesListSearch,
  type SummaryRule,
} from '@/app/(dashboard)/access-lists/access-list-view';

const NOW = new Date('2026-10-05T12:00:00.000Z');

function rule(action: 'allow' | 'deny', kind: SummaryRule['kind'], values: string[], expiresAt: string | null = null): SummaryRule {
  return { action, kind, values, expiresAt };
}

describe('joinAnd', () => {
  it('joins with commas and a last "and"', () => {
    expect(joinAnd([])).toBe('');
    expect(joinAnd(['a'])).toBe('a');
    expect(joinAnd(['a', 'b'])).toBe('a and b');
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('describeSources', () => {
  it('names a few values and counts many', () => {
    expect(describeSources([rule('allow', 'ip', ['203.0.113.0/26', '10.13.13.0/24'])])).toBe('203.0.113.0/26 and 10.13.13.0/24');
    expect(describeSources([rule('allow', 'ip', ['192.0.2.1', '192.0.2.2', '203.0.113.0/24'])])).toBe('2 addresses and 1 network');
    expect(describeSources([rule('allow', 'ip', ['private_ranges'])])).toBe('private networks');
    expect(describeSources([rule('deny', 'country', ['CN', 'RU', 'KP'])])).toBe('CN, RU and KP');
    expect(describeSources([rule('deny', 'country', ['CN', 'RU', 'KP', 'IR'])])).toBe('4 countries');
    expect(describeSources([rule('allow', 'continent', ['EU'])])).toBe('Europe');
    expect(describeSources([rule('deny', 'asn', ['64500'])])).toBe('AS64500');
    expect(describeSources([rule('deny', 'asn', ['64500', '64501', '64502'])])).toBe('3 AS numbers');
  });

  it('merges the values of several rules without repeating them', () => {
    expect(
      describeSources([rule('deny', 'country', ['CN']), rule('deny', 'country', ['CN', 'RU']), rule('deny', 'asn', ['64500'])])
    ).toBe('CN, RU and AS64500');
  });
});

describe('describeRules and describeAccessList', () => {
  it('describes an allowlist and a blocklist', () => {
    const allowlist = { rules: [rule('allow', 'ip', ['203.0.113.0/26']), rule('allow', 'ip', ['private_ranges'])], defaultAction: 'deny' as const, memberCount: 0 };
    expect(describeAccessList(allowlist, NOW)).toBe('Allows only 203.0.113.0/26 and private networks');
    const blocklist = { rules: [rule('deny', 'country', ['CN', 'RU']), rule('deny', 'asn', ['64500', '64501'])], defaultAction: 'allow' as const, memberCount: 0 };
    expect(describeAccessList(blocklist, NOW)).toBe('Denies CN, RU, AS64500 and AS64501');
  });

  it('follows the order of mixed rules and says what everyone else gets', () => {
    const list = {
      rules: [rule('allow', 'ip', ['192.0.2.10']), rule('deny', 'country', ['IR']), rule('allow', 'country', ['IT', 'FR', 'DE'])],
      defaultAction: 'deny' as const,
      memberCount: 2,
    };
    expect(describeAccessList(list, NOW)).toBe('Allows 192.0.2.10, then denies IR, then allows IT, FR and DE; denies everyone else · basic auth for 2 users');
  });

  it('counts the rules when there are many runs', () => {
    const list = {
      rules: [rule('allow', 'ip', ['192.0.2.1']), rule('deny', 'ip', ['192.0.2.0/24']), rule('allow', 'country', ['IT']), rule('deny', 'country', ['FR'])],
      defaultAction: 'allow' as const,
      memberCount: 0,
    };
    // The trailing deny run differs from the default; four runs are too many to spell out.
    expect(describeRules(list, NOW)).toBe('4 rules; allows everyone else');
  });

  it('leaves out rules that end like the default, expired rules and empty rules', () => {
    const list = {
      rules: [rule('deny', 'ip', ['198.51.100.0/24']), rule('allow', 'ip', ['192.0.2.1']), rule('deny', 'ip', ['203.0.113.9'], '2026-10-01T00:00:00.000Z'), rule('deny', 'ip', [])],
      defaultAction: 'allow' as const,
      memberCount: 0,
    };
    expect(describeAccessList(list, NOW)).toBe('Denies 198.51.100.0/24');
  });

  it('says when a list lets everyone in, denies everyone, or only asks for sign-in', () => {
    expect(describeAccessList({ rules: [], defaultAction: 'allow', memberCount: 0 }, NOW)).toBe('Lets everyone in');
    expect(describeAccessList({ rules: [], defaultAction: 'deny', memberCount: 0 }, NOW)).toBe('Denies everyone');
    expect(describeAccessList({ rules: [], defaultAction: 'allow', memberCount: 1 }, NOW)).toBe('Basic auth for 1 user');
    expect(describeAccessList({ rules: [rule('allow', 'ip', ['192.0.2.1'])], defaultAction: 'allow', memberCount: 0 }, NOW)).toBe('Lets everyone in');
  });
});

describe('listWarning', () => {
  it('warns about a list that denies everyone', () => {
    expect(listWarning({ rules: [], defaultAction: 'deny', memberCount: 3 }, NOW)).toBe('denies_everyone');
    expect(listWarning({ rules: [rule('deny', 'country', ['CN'])], defaultAction: 'deny', memberCount: 0 }, NOW)).toBe('denies_everyone');
    // An allow that has expired lets nobody in any more.
    expect(listWarning({ rules: [rule('allow', 'ip', ['192.0.2.1'], '2026-10-01T00:00:00.000Z')], defaultAction: 'deny', memberCount: 0 }, NOW)).toBe('denies_everyone');
    expect(listWarning({ rules: [rule('allow', 'ip', ['192.0.2.1'])], defaultAction: 'deny', memberCount: 0 }, NOW)).toBeNull();
  });

  it('warns about allow rules that change nothing', () => {
    expect(listWarning({ rules: [rule('allow', 'ip', ['192.0.2.1'])], defaultAction: 'allow', memberCount: 0 }, NOW)).toBe('allow_rules_unused');
    expect(listWarning({ rules: [rule('allow', 'ip', ['192.0.2.1']), rule('deny', 'country', ['CN'])], defaultAction: 'allow', memberCount: 0 }, NOW)).toBeNull();
    expect(listWarning({ rules: [], defaultAction: 'allow', memberCount: 0 }, NOW)).toBeNull();
  });
});

describe('searches', () => {
  const list = {
    name: 'Partners',
    description: 'External agencies',
    rules: [{ ...rule('allow', 'country', ['IT']), note: 'Milan office' }, rule('deny', 'asn', ['64500'])],
    entries: [{ username: 'partner-a' }],
  };
  const hosts = [{ name: 'CRM', domains: ['crm.example.com'] }];

  it('finds a list by name, rule values and names, notes, users and hosts', () => {
    for (const query of ['', 'partners', 'agencies', 'italy', 'milan', 'AS64500', '64500', 'partner-a', 'crm.example', 'crm']) {
      expect(matchesListSearch(list, hosts, query), query).toBe(true);
    }
    expect(matchesListSearch(list, hosts, 'partners crm')).toBe(true);
    expect(matchesListSearch(list, hosts, 'partners vpn')).toBe(false);
    expect(matchesListSearch(list, [], 'crm')).toBe(false);
  });

  it('finds a blocked source by value, country name and reason', () => {
    const blocked = { ...rule('deny', 'country', ['KP']), note: 'Scanners' };
    expect(matchesBlockedSearch(blocked, 'north korea')).toBe(true);
    expect(matchesBlockedSearch(blocked, 'kp')).toBe(true);
    expect(matchesBlockedSearch(blocked, 'scanner')).toBe(true);
    expect(matchesBlockedSearch(blocked, '198.51')).toBe(false);
  });
});
