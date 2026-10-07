import { describe, it, expect } from 'vitest';
import {
  canConfigure,
  evaluateLicense,
  LicenseKeyError,
  verifyLicenseKey,
} from '@/ee/licensing/license';
import { EDITION_FEATURES, FEATURES, FEATURE_INFO } from '@/ee/licensing/features';
import { createTestSigner, licensePayload, signLicense } from '../helpers/license';

const signer = createTestSigner();
const NOW = new Date('2027-01-01T00:00:00.000Z');

describe('verifyLicenseKey', () => {
  it('accepts a key signed by a trusted key', () => {
    const payload = verifyLicenseKey(signLicense(signer, licensePayload(signer)), signer.keys);
    expect(payload).toMatchObject({ id: 'LIC-TEST', edition: 'business', nodes: 3, customer: 'Example S.r.l.' });
  });

  it('tolerates surrounding whitespace from copy and paste', () => {
    expect(() => verifyLicenseKey(`\n  ${signLicense(signer, licensePayload(signer))}  \n`, signer.keys)).not.toThrow();
  });

  it('rejects a key whose payload was changed after signing', () => {
    const [version, , signature] = signLicense(signer, licensePayload(signer)).split('.');
    const forged = Buffer.from(JSON.stringify(licensePayload(signer, { edition: 'enterprise' }))).toString('base64url');
    expect(() => verifyLicenseKey(`${version}.${forged}.${signature}`, signer.keys)).toThrow(/signature does not match/);
  });

  it('rejects a key signed by an untrusted key', () => {
    const other = createTestSigner(signer.kid);
    expect(() => verifyLicenseKey(signLicense(other, licensePayload(other)), signer.keys)).toThrow(/signature does not match/);
  });

  it('rejects a key naming an unknown key id', () => {
    const token = signLicense(signer, licensePayload(signer, { kid: 'unknown' }));
    expect(() => verifyLicenseKey(token, signer.keys)).toThrow(/unknown key/);
  });

  it.each([
    ['empty', ''],
    ['not three parts', 'v1.abc'],
    ['wrong version', 'v2.abc.def'],
    ['non-base64url characters', 'v1.a+b.c/d'],
    ['payload that is not JSON', `v1.${Buffer.from('nope').toString('base64url')}.AAAA`],
    ['too long', `v1.${'a'.repeat(9000)}.b`],
  ])('rejects a malformed key (%s)', (_name, token) => {
    expect(() => verifyLicenseKey(token, signer.keys)).toThrow(LicenseKeyError);
  });

  it.each([
    ['unknown field', { admin: true }],
    ['unknown edition', { edition: 'platinum' }],
    ['zero nodes', { nodes: 0 }],
    ['fractional nodes', { nodes: 1.5 }],
    ['a feature that is not text', { features: [42] }],
    ['features that are not a list', { features: 'fleet' }],
    ['expiry before issue', { exp: '2026-01-01T00:00:00.000Z' }],
    ['unparseable date', { exp: 'next year' }],
    ['empty customer', { customer: '  ' }],
  ])('rejects a signed payload with %s', (_name, overrides) => {
    const token = signLicense(signer, licensePayload(signer, overrides));
    expect(() => verifyLicenseKey(token, signer.keys)).toThrow(LicenseKeyError);
  });

  it('asks for a newer version when the payload version is unknown', () => {
    const token = signLicense(signer, licensePayload(signer, { v: 3 }));
    expect(() => verifyLicenseKey(token, signer.keys)).toThrow(/newer version/);
  });

  it('accepts an online key (payload v2) with the same fields', () => {
    expect(verifyLicenseKey(signLicense(signer, licensePayload(signer, { v: 2 })), signer.keys)).toMatchObject({ v: 2, id: 'LIC-TEST' });
  });
});

describe('evaluateLicense', () => {
  it('reports unlicensed without a key', () => {
    expect(evaluateLicense(null, signer.keys, NOW)).toMatchObject({ status: 'unlicensed', features: [] });
  });

  it('reports an invalid key with a safe reason and no features', () => {
    const state = evaluateLicense('v1.bad.key', signer.keys, NOW);
    expect(state.status).toBe('invalid');
    expect(state.features).toEqual([]);
    expect(state.error).toBe('The license key is not valid');
  });

  it('is active until expiry, then in grace for 30 days, then expired', () => {
    const token = signLicense(signer, licensePayload(signer, { exp: '2027-01-01T00:00:00.000Z' }));
    expect(evaluateLicense(token, signer.keys, new Date('2027-01-01T00:00:00.000Z')).status).toBe('active');
    const grace = evaluateLicense(token, signer.keys, new Date('2027-01-15T00:00:00.000Z'));
    expect(grace.status).toBe('grace');
    expect(grace.graceEndsAt).toBe('2027-01-31T00:00:00.000Z');
    expect(evaluateLicense(token, signer.keys, new Date('2027-01-31T00:00:00.000Z')).status).toBe('grace');
    expect(evaluateLicense(token, signer.keys, new Date('2027-01-31T00:00:01.000Z')).status).toBe('expired');
  });

  it('treats a key issued more than a day in the future as not valid yet', () => {
    const token = signLicense(signer, licensePayload(signer, { iat: '2027-01-03T00:00:00.000Z', exp: '2028-01-01T00:00:00.000Z' }));
    expect(evaluateLicense(token, signer.keys, NOW)).toMatchObject({ status: 'invalid', error: 'The license key is not valid yet' });
  });

  it('grants the edition features plus any extra features', () => {
    const token = signLicense(signer, licensePayload(signer, { edition: 'homelab', features: ['approvals'] }));
    const state = evaluateLicense(token, signer.keys, NOW);
    expect(state.features.sort()).toEqual([...EDITION_FEATURES.homelab, 'approvals'].sort());
  });

  it('ignores a feature this release does not know, newer or withdrawn, and keeps the rest of the key', () => {
    const token = signLicense(signer, licensePayload(signer, { edition: 'homelab', features: ['approvals', 'virtual_patching', 'everything'] }));
    const state = evaluateLicense(token, signer.keys, NOW);
    expect(state.status).toBe('active');
    expect(state.features.sort()).toEqual([...EDITION_FEATURES.homelab, 'approvals'].sort());
  });
});

describe('canConfigure', () => {
  const at = (exp: string, now: Date) =>
    evaluateLicense(signLicense(signer, licensePayload(signer, { exp })), signer.keys, now);

  it('allows included features while active and during grace', () => {
    expect(canConfigure(at('2027-06-01T00:00:00.000Z', NOW), 'audit_streaming')).toBe(true);
    expect(canConfigure(at('2026-12-20T00:00:00.000Z', NOW), 'audit_streaming')).toBe(true);
  });

  it('makes features read-only after the grace period', () => {
    expect(canConfigure(at('2026-11-01T00:00:00.000Z', NOW), 'audit_streaming')).toBe(false);
  });

  it('refuses features the edition does not include', () => {
    expect(canConfigure(at('2027-06-01T00:00:00.000Z', NOW), 'approvals')).toBe(false);
  });
});

describe('feature catalogue', () => {
  it('describes every feature and assigns it to the edition that first includes it', () => {
    for (const feature of FEATURES) {
      const info = FEATURE_INFO[feature];
      expect(info.label.length).toBeGreaterThan(0);
      expect(EDITION_FEATURES[info.edition]).toContain(feature);
    }
  });

  it('keeps editions nested: business has all of homelab, enterprise all of business', () => {
    for (const feature of EDITION_FEATURES.homelab) expect(EDITION_FEATURES.business).toContain(feature);
    for (const feature of EDITION_FEATURES.business) expect(EDITION_FEATURES.enterprise).toContain(feature);
  });
});
