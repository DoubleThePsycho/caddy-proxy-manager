import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { LICENSE_VERSION, signingInput, type TrustedKeys } from '@/ee/licensing/license';

export type TestSigner = { kid: string; privateKey: KeyObject; keys: TrustedKeys };

/** A throwaway Ed25519 key, trusted only by the tests that ask for it. */
export function createTestSigner(kid = 'test-key'): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { kid, privateKey, keys: new Map([[kid, publicKey]]) };
}

/** Signs any payload, including deliberately malformed ones. */
export function signLicense(signer: TestSigner, payload: Record<string, unknown>): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, signingInput(payloadPart), signer.privateKey).toString('base64url');
  return `${LICENSE_VERSION}.${payloadPart}.${signature}`;
}

export function licensePayload(signer: TestSigner, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kid: signer.kid,
    id: 'LIC-TEST',
    customer: 'Example S.r.l.',
    edition: 'business',
    nodes: 3,
    iat: '2026-10-01T00:00:00.000Z',
    exp: '2027-10-01T00:00:00.000Z',
    ...overrides,
  };
}
