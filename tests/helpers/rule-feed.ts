import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { feedDocument, feedSigningInput, type TrustedFeedKeys } from '@/ee/rule-feed/feed';
import type { RulePack } from '@/ee/rule-feed/types';

export type FeedSigner = { kid: string; privateKey: KeyObject; keys: TrustedFeedKeys };

/** A throwaway Ed25519 key, trusted only by the tests that ask for it. */
export function createFeedSigner(kid = 'test-feed-key'): FeedSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { kid, privateKey, keys: new Map([[kid, publicKey]]) };
}

/** Signs any payload, including deliberately malformed ones, over the feed's signing context. */
export function signFeed(signer: FeedSigner, payload: unknown): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return feedDocument(payloadPart, sign(null, feedSigningInput(payloadPart), signer.privateKey));
}

const EXAMPLES = join(process.cwd(), 'ee/rule-feed/examples');

/** The example packs shipped in ee/rule-feed/examples, by id. */
export function examplePacks(): RulePack[] {
  return readdirSync(EXAMPLES)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(EXAMPLES, name), 'utf8')) as RulePack);
}

export function examplePack(id: string): RulePack {
  const pack = examplePacks().find((candidate) => candidate.id === id);
  if (!pack) throw new Error(`no example pack ${id}`);
  return structuredClone(pack);
}

/** A minimal valid pack with one rule. */
export function testPack(overrides: Partial<RulePack> & Record<string, unknown> = {}): RulePack {
  return {
    id: 'ivp-test-0001',
    cves: ['CVE-2026-0001'],
    title: 'Example application path traversal',
    summary: 'A test pack.',
    affected: [{ product: 'Example App', versions: '1.0 to 1.2', fixed: '1.3' }],
    severity: 'high',
    publishedAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    references: ['https://example.com/advisory'],
    defaultMode: 'block',
    rules: ['SecRule REQUEST_FILENAME "@contains /example-exploit" "id:1800000001,phase:1,t:none,t:lowercase"'],
    samples: { positive: [{ method: 'GET', path: '/example-exploit' }], negative: [{ method: 'GET', path: '/' }] },
    ...overrides,
  } as RulePack;
}

/** A feed payload valid at `now` (default 2026-10-03). */
export function feedPayload(signer: FeedSigner, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kid: signer.kid,
    sequence: 100,
    issuedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-31T00:00:00.000Z',
    packs: [testPack()],
    ...overrides,
  };
}

export const FEED_NOW = new Date('2026-10-03T12:00:00.000Z');
