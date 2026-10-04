import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/src/lib/models/certificates', () => ({
  listCertificates: vi.fn(),
  createCertificate: vi.fn(),
  getCertificate: vi.fn(),
  updateCertificate: vi.fn(),
  deleteCertificate: vi.fn(),
}));

vi.mock('@/src/lib/api-auth', () => {
  const ApiAuthError = class extends Error {
    status: number;
    constructor(msg: string, status: number) { super(msg); this.status = status; this.name = 'ApiAuthError'; }
  };
  return {
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
    requireApiUser: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
    apiErrorResponse: vi.fn((error: unknown) => {
      const { NextResponse: NR } = require('next/server');
      if (error instanceof ApiAuthError) {
        return NR.json({ error: error.message }, { status: error.status });
      }
      return NR.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
    }),
    ApiAuthError,
  };
});

import { GET as listGET, POST } from '@/app/api/v1/certificates/route';
import { GET as getGET, PUT, DELETE } from '@/app/api/v1/certificates/[id]/route';
import { listCertificates, createCertificate, getCertificate, updateCertificate, deleteCertificate } from '@/src/lib/models/certificates';
import { requireApiAdmin } from '@/src/lib/api-auth';

const mockList = vi.mocked(listCertificates);
const mockCreate = vi.mocked(createCertificate);
const mockGet = vi.mocked(getCertificate);
const mockUpdate = vi.mocked(updateCertificate);
const mockDelete = vi.mocked(deleteCertificate);
const mockRequireApiAdmin = vi.mocked(requireApiAdmin);

function createMockRequest(options: { method?: string; body?: unknown } = {}): any {
  return {
    headers: { get: () => null },
    method: options.method ?? 'GET',
    nextUrl: { pathname: '/api/v1/certificates', searchParams: new URLSearchParams() },
    json: async () => options.body ?? {},
  };
}

const PRIVATE_KEY_SENTINEL = '-----BEGIN PRIVATE KEY-----\nunit-secret-sentinel\n-----END PRIVATE KEY-----';

const sampleCert = {
  id: 1,
  name: 'Secure certificate',
  type: 'imported',
  domainNames: ['secure.example.com'],
  autoRenew: false,
  providerOptions: null,
  certificatePem: '-----BEGIN CERTIFICATE-----\npublic-certificate\n-----END CERTIFICATE-----',
  privateKeyPem: PRIVATE_KEY_SENTINEL,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireApiAdmin.mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' });
});

describe('GET /api/v1/certificates', () => {
  it('returns list of certificates', async () => {
    mockList.mockResolvedValue([{
      ...sampleCert,
      futurePrivateMaterial: 'future-secret-field-sentinel',
    }] as any);

    const response = await listGET(createMockRequest());
    const bodyText = await response.text();
    const data = JSON.parse(bodyText);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(data).toEqual([{
      id: sampleCert.id,
      name: sampleCert.name,
      type: sampleCert.type,
      domainNames: sampleCert.domainNames,
      autoRenew: sampleCert.autoRenew,
      providerOptions: sampleCert.providerOptions,
      certificatePem: sampleCert.certificatePem,
      hasPrivateKey: true,
      createdAt: sampleCert.createdAt,
      updatedAt: sampleCert.updatedAt,
    }]);
    expect(bodyText).not.toContain(PRIVATE_KEY_SENTINEL);
    expect(bodyText).not.toContain('privateKeyPem');
    expect(bodyText).not.toContain('future-secret-field-sentinel');
  });

  it('returns 401 on auth failure', async () => {
    const { ApiAuthError } = await import('@/src/lib/api-auth');
    mockRequireApiAdmin.mockRejectedValue(new ApiAuthError('Unauthorized', 401));

    const response = await listGET(createMockRequest());
    expect(response.status).toBe(401);
  });
});

describe('POST /api/v1/certificates', () => {
  it('creates a certificate and returns 201', async () => {
    const body = { name: 'New certificate', domainNames: ['new.example.com'], type: 'managed' };
    mockCreate.mockResolvedValue({ id: 2, ...body } as any);

    const response = await POST(createMockRequest({ method: 'POST', body }));
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.id).toBe(2);
    expect(data.hasPrivateKey).toBe(false);
    expect(mockCreate).toHaveBeenCalledWith(body, 1);
  });
});

describe('GET /api/v1/certificates/[id]', () => {
  it('returns a certificate by id', async () => {
    mockGet.mockResolvedValue(sampleCert as any);

    const response = await getGET(createMockRequest(), { params: Promise.resolve({ id: '1' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.hasPrivateKey).toBe(true);
    expect(data.privateKeyPem).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(PRIVATE_KEY_SENTINEL);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns 404 for non-existent certificate', async () => {
    mockGet.mockResolvedValue(null as any);

    const response = await getGET(createMockRequest(), { params: Promise.resolve({ id: '999' }) });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Not found');
  });
});

describe('PUT /api/v1/certificates/[id]', () => {
  it('updates a certificate', async () => {
    const body = { domainNames: ['updated.example.com'] };
    mockUpdate.mockResolvedValue({ ...sampleCert, domainNames: ['updated.example.com'] } as any);

    const response = await PUT(createMockRequest({ method: 'PUT', body }), { params: Promise.resolve({ id: '1' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.domainNames).toEqual(['updated.example.com']);
    expect(data.hasPrivateKey).toBe(true);
    expect(data.privateKeyPem).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(PRIVATE_KEY_SENTINEL);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockUpdate).toHaveBeenCalledWith(1, body, 1);
  });

  it('returns 500 when certificate not found', async () => {
    mockUpdate.mockRejectedValue(new Error('not found'));

    const response = await PUT(createMockRequest({ method: 'PUT', body: { domains: ['x.com'] } }), { params: Promise.resolve({ id: '999' }) });
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('not found');
  });
});

describe('DELETE /api/v1/certificates/[id]', () => {
  it('deletes a certificate', async () => {
    mockDelete.mockResolvedValue(undefined as any);

    const response = await DELETE(createMockRequest({ method: 'DELETE' }), { params: Promise.resolve({ id: '1' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(mockDelete).toHaveBeenCalledWith(1, 1);
  });

  it('returns 500 when certificate not found', async () => {
    mockDelete.mockRejectedValue(new Error('not found'));

    const response = await DELETE(createMockRequest({ method: 'DELETE' }), { params: Promise.resolve({ id: '999' }) });
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('not found');
  });
});

describe('POST /api/v1/certificates - input variations', () => {
  it('creates managed certificate with provider options', async () => {
    const managedCert = {
      name: 'Wildcard',
      type: 'managed',
      domainNames: ['*.example.com'],
      autoRenew: true,
      providerOptions: { provider: 'cloudflare', api_token: 'cloudflare-token' },
    };
    mockCreate.mockResolvedValue({
      id: 10,
      ...managedCert,
      certificatePem: null,
      privateKeyPem: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as any);

    const response = await POST(createMockRequest({ method: 'POST', body: managedCert }));
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.id).toBe(10);
    expect(data.type).toBe('managed');
    expect(data.providerOptions).toEqual({ provider: 'cloudflare' });
    expect(JSON.stringify(data)).not.toContain('cloudflare-token');
    expect(data.certificatePem).toBeNull();
    expect(data.hasPrivateKey).toBe(false);
    expect(data.privateKeyPem).toBeUndefined();
    expect(mockCreate).toHaveBeenCalledWith(managedCert, 1);
  });

  it('creates imported certificate with PEM', async () => {
    const importedCert = {
      name: 'Custom Cert',
      type: 'imported',
      domainNames: ['custom.example.com'],
      autoRenew: false,
      certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
      privateKeyPem: PRIVATE_KEY_SENTINEL,
    };
    mockCreate.mockResolvedValue({
      id: 11,
      ...importedCert,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as any);

    const response = await POST(createMockRequest({ method: 'POST', body: importedCert }));
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.id).toBe(11);
    expect(data.type).toBe('imported');
    expect(data.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(data.hasPrivateKey).toBe(true);
    expect(data.privateKeyPem).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(PRIVATE_KEY_SENTINEL);
    expect(mockCreate).toHaveBeenCalledWith(importedCert, 1);
  });
});

describe('GET /api/v1/certificates/[id] - full fields', () => {
  it('returns certificate with all fields', async () => {
    const fullCert = {
      id: 1,
      name: 'Full Cert',
      type: 'imported',
      domainNames: ['secure.example.com'],
      autoRenew: false,
      providerOptions: null,
      certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
      privateKeyPem: PRIVATE_KEY_SENTINEL,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    mockGet.mockResolvedValue(fullCert as any);

    const response = await getGET(createMockRequest(), { params: Promise.resolve({ id: '1' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(1);
    expect(data.name).toBe('Full Cert');
    expect(data.type).toBe('imported');
    expect(data.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(data.hasPrivateKey).toBe(true);
    expect(data.privateKeyPem).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(PRIVATE_KEY_SENTINEL);
    expect(data.autoRenew).toBe(false);
    expect(data.createdAt).toBe('2026-01-01');
    expect(data.updatedAt).toBe('2026-01-01');
  });
});
