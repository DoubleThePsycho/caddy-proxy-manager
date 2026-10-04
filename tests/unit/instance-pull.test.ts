/**
 * A pull replica's configuration from the environment, the credential form,
 * the token its fingerprints are keyed with, and the proof that it holds the
 * sync key it presents (ee/fleet/pull-config.ts, src/lib/sync-crypto.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getPullReplicaConfig,
  isPullCredential,
  pullCredentialHash,
  pullFingerprintToken,
} from '@/ee/fleet/pull-config';
import {
  createSyncKeyChallenge,
  createSyncKeyResponse,
  parseSyncKeyRotationProofs,
  parseSyncPublicKeyResponse,
  verifySyncKeyPossession,
} from '@/src/lib/sync-crypto';

const CREDENTIAL = `pull_${'a'.repeat(43)}`;
const KEYS = ['INSTANCE_SYNC_MODE', 'INSTANCE_MASTER_URL', 'INSTANCE_PULL_TOKEN', 'INSTANCE_PULL_INTERVAL', 'INSTANCE_SYNC_ALLOW_HTTP'];

function setEnv(values: Record<string, string>) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe('pull replica configuration', () => {
  it('is push unless INSTANCE_SYNC_MODE is pull', () => {
    setEnv({});
    expect(getPullReplicaConfig()).toEqual({ mode: 'push' });
    setEnv({ INSTANCE_SYNC_MODE: 'push', INSTANCE_MASTER_URL: 'https://master.example.com', INSTANCE_PULL_TOKEN: CREDENTIAL });
    expect(getPullReplicaConfig()).toEqual({ mode: 'push' });
  });

  it('reads the master URL, the credential and the interval', () => {
    setEnv({ INSTANCE_SYNC_MODE: 'Pull', INSTANCE_MASTER_URL: 'https://master.example.com/dash/', INSTANCE_PULL_TOKEN: CREDENTIAL });
    expect(getPullReplicaConfig()).toEqual({
      mode: 'pull', ok: true, masterUrl: 'https://master.example.com/dash', credential: CREDENTIAL, intervalSeconds: 30,
    });
    process.env.INSTANCE_PULL_INTERVAL = '5';
    expect(getPullReplicaConfig()).toMatchObject({ intervalSeconds: 10 });
    process.env.INSTANCE_PULL_INTERVAL = '999999';
    expect(getPullReplicaConfig()).toMatchObject({ intervalSeconds: 3600 });
    process.env.INSTANCE_PULL_INTERVAL = 'often';
    expect(getPullReplicaConfig()).toMatchObject({ intervalSeconds: 30 });
  });

  it('needs https unless plain HTTP is allowed explicitly', () => {
    setEnv({ INSTANCE_SYNC_MODE: 'pull', INSTANCE_MASTER_URL: 'http://master.example.com', INSTANCE_PULL_TOKEN: CREDENTIAL });
    expect(getPullReplicaConfig()).toMatchObject({ mode: 'pull', ok: false, error: expect.stringMatching(/must use https/) });
    process.env.INSTANCE_SYNC_ALLOW_HTTP = 'true';
    expect(getPullReplicaConfig()).toMatchObject({ ok: true, masterUrl: 'http://master.example.com' });
  });

  it('refuses unusable URLs and credentials without echoing them', () => {
    for (const url of ['', 'ftp://master.example.com', 'https://user:secret@master.example.com', 'https://master.example.com/?x=1']) {
      setEnv({ INSTANCE_SYNC_MODE: 'pull', INSTANCE_MASTER_URL: url, INSTANCE_PULL_TOKEN: CREDENTIAL });
      const config = getPullReplicaConfig();
      expect(config, url).toMatchObject({ ok: false });
      expect(JSON.stringify(config)).not.toContain('secret@');
    }
    setEnv({ INSTANCE_SYNC_MODE: 'pull', INSTANCE_MASTER_URL: 'https://master.example.com', INSTANCE_PULL_TOKEN: 'not-a-pull-credential-0123456789' });
    const config = getPullReplicaConfig();
    expect(config).toMatchObject({ ok: false, error: expect.stringMatching(/not a pull credential/) });
    expect(JSON.stringify(config)).not.toContain('not-a-pull-credential');
  });
});

describe('pull credentials', () => {
  it('have a fixed form; the master keeps their hash and a token derived from them', () => {
    expect(isPullCredential(CREDENTIAL)).toBe(true);
    expect(isPullCredential(`${CREDENTIAL}x`)).toBe(false);
    expect(isPullCredential(`scim_${'a'.repeat(43)}`)).toBe(false);
    expect(pullCredentialHash(CREDENTIAL)).toMatch(/^[0-9a-f]{64}$/);
    const token = pullFingerprintToken(CREDENTIAL);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).toBe(pullFingerprintToken(CREDENTIAL));
    expect(token).not.toBe(pullFingerprintToken(`pull_${'b'.repeat(43)}`));
    expect(token).not.toContain(CREDENTIAL.slice(5, 20));
  });
});

describe('proof of the sync key', () => {
  it('proves the current key for the challenge, and only for it', () => {
    const challenge = createSyncKeyChallenge();
    const response = createSyncKeyResponse(challenge.value, { proveCurrentKey: true });
    const key = parseSyncPublicKeyResponse(response)!;
    const proofs = parseSyncKeyRotationProofs(response);
    expect(proofs.map((proof) => proof.keyId)).toEqual([key.keyId]);
    expect(verifySyncKeyPossession(challenge, key, proofs)).toBe(true);
    // Another challenge, another nonce, or no proof: nothing proved.
    expect(verifySyncKeyPossession(createSyncKeyChallenge(), key, proofs)).toBe(false);
    expect(verifySyncKeyPossession(challenge, { ...key, nonce: createSyncKeyResponse(null).nonce }, proofs)).toBe(false);
    expect(verifySyncKeyPossession(challenge, key, [])).toBe(false);
    // A pushed slave's key reply carries no proof of its current key.
    expect(createSyncKeyResponse(challenge.value).rotationProofs).toBeUndefined();
  });
});
