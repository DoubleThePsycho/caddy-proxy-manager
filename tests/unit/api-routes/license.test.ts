import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const settingsStore = new Map<string, unknown>();

vi.mock('@/src/lib/settings', () => ({
  getSetting: vi.fn(async (key: string) => (settingsStore.has(key) ? settingsStore.get(key) : null)),
  setSetting: vi.fn(async (key: string, value: unknown) => { settingsStore.set(key, value); }),
  clearSetting: vi.fn(async (key: string) => { settingsStore.delete(key); }),
}));

vi.mock('@/src/lib/models/instances', () => ({
  listInstances: vi.fn(async () => [
    { id: 1, enabled: true },
    { id: 2, enabled: false },
  ]),
}));

vi.mock('@/src/lib/instance-sync', () => ({
  getEnvSlaveInstances: vi.fn(() => [{ name: 'env', url: 'https://replica.example.com', token: 'x' }]),
}));

vi.mock('@/src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

vi.mock('@/src/lib/api-auth', () => {
  const ApiAuthError = class extends Error {
    status: number;
    constructor(msg: string, status: number) { super(msg); this.status = status; this.name = 'ApiAuthError'; }
  };
  return {
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn().mockResolvedValue({ userId: 7, role: 'admin', authMethod: 'bearer' }),
    apiErrorResponse: vi.fn((error: unknown) => {
      const { NextResponse: NR } = require('next/server');
      const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 500;
      return NR.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status });
    }),
    ApiAuthError,
  };
});

import { GET, PUT, DELETE } from '@/app/api/v1/license/route';
import { POST as VERIFY } from '@/app/api/v1/license/verify/route';
import { requireApiAdmin, requireApiPermission } from '@/src/lib/api-auth';
import { setSetting } from '@/src/lib/settings';
import { logAuditEvent } from '@/src/lib/audit';
import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { requireFeature, LicenseRequiredError, LICENSE_SETTING_KEY } from '@/ee/licensing/store';
import { createTestSigner, licensePayload, signLicense } from '../../helpers/license';

const signer = createTestSigner();
const farFuture = { iat: '2026-01-01T00:00:00.000Z', exp: '2099-01-01T00:00:00.000Z' };

function request(method: string, body?: unknown): any {
  return {
    method,
    headers: { get: () => null },
    nextUrl: { pathname: '/api/v1/license', searchParams: new URLSearchParams() },
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  };
}

beforeEach(() => {
  settingsStore.clear();
  vi.clearAllMocks();
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId: 7, role: 'admin', authMethod: 'bearer' });
  setTrustedLicenseKeysForTests(signer.keys);
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('GET /api/v1/license', () => {
  it('reports Community with node usage when no key is installed', async () => {
    const response = await GET(request('GET'));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.status).toBe('unlicensed');
    // itself + one enabled instance + one INSTANCE_SLAVES entry
    expect(data.nodes).toEqual({ licensed: null, used: 3, overLimit: false });
    expect(data.features.every((f: { included: boolean }) => !f.included)).toBe(true);
  });

  it('requires an administrator', async () => {
    const { ApiAuthError } = await import('@/src/lib/api-auth') as any;
    vi.mocked(requireApiAdmin).mockRejectedValueOnce(new ApiAuthError('Administrator privileges required', 403));
    const response = await GET(request('GET'));
    expect(response.status).toBe(403);
  });
});

describe('PUT /api/v1/license', () => {
  it('installs a valid key, audits it and never echoes the key', async () => {
    const key = signLicense(signer, licensePayload(signer, { ...farFuture, nodes: 2 }));
    const response = await PUT(request('PUT', { key }));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toMatchObject({ status: 'active', edition: 'business', licenseId: 'LIC-TEST', nodes: { licensed: 2, used: 3, overLimit: true } });
    expect(JSON.stringify(data)).not.toContain(key);
    expect(settingsStore.get(LICENSE_SETTING_KEY)).toBe(key);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, action: 'license_installed', entityType: 'license' }));
  });

  it('refuses an invalid key without storing it', async () => {
    const response = await PUT(request('PUT', { key: 'v1.not.valid' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('The license key is not valid');
    expect(settingsStore.has(LICENSE_SETTING_KEY)).toBe(false);
  });

  it('refuses a key past its grace period', async () => {
    const key = signLicense(signer, licensePayload(signer, { iat: '2020-01-01T00:00:00.000Z', exp: '2021-01-01T00:00:00.000Z' }));
    const response = await PUT(request('PUT', { key }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('This license expired on 2021-01-01');
  });

  it.each([
    ['no body', undefined],
    ['a string body', 'v1.a.b'],
    ['a missing key', {}],
    ['an empty key', { key: '  ' }],
  ])('rejects %s', async (_name, body) => {
    const response = await PUT(request('PUT', body));
    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/v1/license', () => {
  it('removes the key and audits it', async () => {
    settingsStore.set(LICENSE_SETTING_KEY, signLicense(signer, licensePayload(signer, farFuture)));
    const response = await DELETE(request('DELETE'));
    expect(response.status).toBe(204);
    expect(settingsStore.has(LICENSE_SETTING_KEY)).toBe(false);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'license_removed', summary: 'Removed license LIC-TEST' }));
  });
});

describe('POST /api/v1/license/verify', () => {
  function verifyRequest(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): any {
    return new Request('http://localhost/api/v1/license/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      // A streamed body (no Content-Length) needs the half-duplex flag.
      ...(typeof body === 'string' ? {} : { duplex: 'half' }),
    } as RequestInit);
  }

  it('needs license:write', async () => {
    const response = await VERIFY(verifyRequest(JSON.stringify({ key: 'v1.a.b' })));
    expect(response.status).toBe(200);
    expect(vi.mocked(requireApiPermission).mock.calls[0][1]).toBe('license:write');

    const { ApiAuthError } = await import('@/src/lib/api-auth') as any;
    vi.mocked(requireApiAdmin).mockRejectedValueOnce(new ApiAuthError('Missing permission license:write', 403));
    const denied = await VERIFY(verifyRequest(JSON.stringify({ key: 'v1.a.b' })));
    expect(denied.status).toBe(403);
  });

  it('says what a valid key grants without storing it, auditing it or echoing it', async () => {
    const installed = signLicense(signer, licensePayload(signer, { ...farFuture, id: 'LIC-OLD' }));
    settingsStore.set(LICENSE_SETTING_KEY, installed);
    const key = signLicense(signer, licensePayload(signer, { ...farFuture, id: 'LIC-NEW', edition: 'enterprise', nodes: 20, trial: true }));
    const response = await VERIFY(verifyRequest(JSON.stringify({ key })));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(data).toMatchObject({
      installable: true,
      status: 'active',
      error: null,
      keyId: 'test-key',
      licenseId: 'LIC-NEW',
      edition: 'enterprise',
      editionLabel: 'Enterprise',
      customer: 'Example S.r.l.',
      trial: true,
      nodes: 20,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(data.features).toEqual(expect.arrayContaining(['fleet', 'approvals', 'alerting']));
    expect(data.features).toContain('white_label');
    expect(JSON.stringify(data)).not.toContain(key);
    expect(settingsStore.get(LICENSE_SETTING_KEY)).toBe(installed);
    expect(setSetting).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('answers 200 with the reason for keys that cannot be installed', async () => {
    const invalid = await (await VERIFY(verifyRequest(JSON.stringify({ key: 'v1.not.valid' })))).json();
    expect(invalid).toMatchObject({ installable: false, status: 'invalid', error: 'The license key is not valid', edition: null, features: [] });

    const expiredKey = signLicense(signer, licensePayload(signer, { iat: '2020-01-01T00:00:00.000Z', exp: '2021-01-01T00:00:00.000Z' }));
    const expired = await (await VERIFY(verifyRequest(JSON.stringify({ key: expiredKey })))).json();
    expect(expired).toMatchObject({ installable: false, status: 'expired', error: 'This license expired on 2021-01-01', edition: 'business' });

    const [version, payloadPart, signature] = signLicense(signer, licensePayload(signer, farFuture)).split('.');
    // Position 10 carries six data bits (the last character carries padding bits too).
    const flipped = signature.slice(0, 10) + (signature[10] === 'A' ? 'B' : 'A') + signature.slice(11);
    const badSignature = await (await VERIFY(verifyRequest(JSON.stringify({ key: `${version}.${payloadPart}.${flipped}` })))).json();
    expect(badSignature).toMatchObject({ installable: false, error: "The license key's signature does not match" });
    expect(settingsStore.has(LICENSE_SETTING_KEY)).toBe(false);
  });

  it.each([
    ['an empty body', ''],
    ['a body that is not JSON', 'v1.a.b'],
    ['an array', '[]'],
    ['a missing key', '{}'],
    ['an empty key', '{"key":"  "}'],
    ['a key that is not a string', '{"key":42}'],
  ])('rejects %s with 400', async (_name, body) => {
    const response = await VERIFY(verifyRequest(body));
    expect(response.status).toBe(400);
  });

  it('refuses a declared body over 16 KiB with 413 before reading it', async () => {
    const response = await VERIFY(verifyRequest('{}', { 'content-length': String(64 * 1024) }));
    expect(response.status).toBe(413);
  });

  it('stops reading a streamed body once it passes 16 KiB', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) return controller.close();
        controller.enqueue(new Uint8Array(4096).fill(97));
      },
    });
    const response = await VERIFY(verifyRequest(stream));
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });
});

describe('requireFeature', () => {
  it('throws a 403 naming the edition when unlicensed', async () => {
    const error = await requireFeature('audit_streaming').catch((e) => e);
    expect(error).toBeInstanceOf(LicenseRequiredError);
    expect(error.status).toBe(403);
    expect(error.message).toBe('Audit streaming and export needs an active Ingressi Business license or higher');
  });

  it('passes for a feature the installed license includes', async () => {
    settingsStore.set(LICENSE_SETTING_KEY, signLicense(signer, licensePayload(signer, farFuture)));
    await expect(requireFeature('audit_streaming')).resolves.toBeUndefined();
    await expect(requireFeature('approvals')).rejects.toBeInstanceOf(LicenseRequiredError);
  });
});

describe('trusted keys', () => {
  it('cannot be replaced outside tests', () => {
    const previous = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    try {
      expect(() => setTrustedLicenseKeysForTests(signer.keys)).toThrow(/only be replaced in tests/);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = previous!;
    }
  });
});
