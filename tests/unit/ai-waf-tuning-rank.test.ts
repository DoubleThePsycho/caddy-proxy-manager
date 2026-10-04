import { describe, expect, it } from 'vitest';
import { MIN_SUGGESTION_SCORE, compareSuggestions, rankCandidate, ruleFamily, type CandidateStats } from '@/ee/ai/waf-tuning-rank';

function stats(overrides: Partial<CandidateStats> = {}): CandidateStats {
  return {
    ruleId: 920420,
    events: 400,
    clients: 60,
    activeDays: 10,
    blockedEvents: 0,
    criticalEvents: 0,
    averageAnomalyScore: null,
    cleanClients: 55,
    normalClients: 50,
    pathPrefixes: [{ prefix: '/api/upload', events: 380, clients: 58, examplePaths: ['/api/upload/chunk'] }],
    ...overrides,
  };
}

describe('ruleFamily', () => {
  it('knows the CRS families and which are attack-critical', () => {
    expect(ruleFamily(942100)).toEqual({ name: 'SQL injection', critical: true });
    expect(ruleFamily(932160)).toEqual({ name: 'Remote code execution', critical: true });
    expect(ruleFamily(941100)).toEqual({ name: 'Cross-site scripting', critical: false });
    expect(ruleFamily(920420)).toEqual({ name: 'Protocol enforcement', critical: false });
    // Anomaly evaluation, initialization and custom rules are never suggested.
    expect(ruleFamily(949110)).toBeNull();
    expect(ruleFamily(901001)).toBeNull();
    expect(ruleFamily(9001)).toBeNull();
  });
});

describe('rankCandidate', () => {
  it('rates a widespread, detection-only rule hit by normal clients as high confidence', () => {
    const ranking = rankCandidate(stats());
    expect(ranking.confidence).toBe('high');
    expect(ranking.score).toBeGreaterThanOrEqual(70);
    expect(ranking.attackCritical).toBe(false);
    expect(ranking.reasons).toEqual(expect.arrayContaining([
      'Matched 400 times for 60 different clients on 10 days',
      '100% of the matches did not block the request (detection-only or below the anomaly threshold)',
      '55 of 60 clients triggered no other WAF rule',
      '50 of 60 clients also made successful requests to this host',
      '95% of the matches are under /api/upload',
    ]));
  });

  it('never rates an attack-critical family as high confidence', () => {
    const sqli = rankCandidate(stats({ ruleId: 942100 }));
    expect(sqli.attackCritical).toBe(true);
    expect(sqli.confidence).toBe('medium');
    expect(sqli.reasons.join(' ')).toMatch(/SQL injection rule: .* never a high-confidence suggestion/);
  });

  it('rates attack-critical rules with severe matches as low confidence', () => {
    for (const severe of [
      { criticalEvents: 300 },
      { averageAnomalyScore: 25 },
      { blockedEvents: 380 },
    ]) {
      expect(rankCandidate(stats({ ruleId: 932160, ...severe })).confidence).toBe('low');
    }
  });

  it('does not suggest blocked matches from clients that also trigger other rules', () => {
    const ranking = rankCandidate(stats({ ruleId: 941100, clients: 6, activeDays: 2, blockedEvents: 380, criticalEvents: 380, cleanClients: 1, normalClients: 0, averageAnomalyScore: 20 }));
    expect(ranking.confidence).toBe('low');
    expect(ranking.score).toBeLessThan(MIN_SUGGESTION_SCORE);
    expect(ranking.suggest).toBe(false);
    expect(rankCandidate(stats()).suggest).toBe(true);
  });

  it('ignores the traffic signal when there is no traffic data', () => {
    const ranking = rankCandidate(stats({ normalClients: null }));
    expect(ranking.confidence).toBe('high');
    expect(ranking.reasons.join(' ')).not.toMatch(/successful requests/);
  });

  it('needs many clean clients for high confidence', () => {
    expect(rankCandidate(stats({ cleanClients: 20 })).confidence).not.toBe('high');
    expect(rankCandidate(stats({ clients: 8, cleanClients: 8, normalClients: 8 })).confidence).not.toBe('high');
  });
});

describe('compareSuggestions', () => {
  it('orders by confidence, then by volume', () => {
    const items = [
      { id: 'low-big', confidence: 'low' as const, events: 9000, clients: 900, score: 40 },
      { id: 'high-small', confidence: 'high' as const, events: 50, clients: 12, score: 75 },
      { id: 'high-big', confidence: 'high' as const, events: 500, clients: 40, score: 72 },
      { id: 'medium', confidence: 'medium' as const, events: 5000, clients: 300, score: 60 },
    ];
    expect(items.sort(compareSuggestions).map((item) => item.id)).toEqual(['high-big', 'high-small', 'medium', 'low-big']);
  });
});
