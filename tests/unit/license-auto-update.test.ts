/**
 * Automatic license updates, the parts without a database: the environment
 * switches, the refresh token and request body validation, the one request
 * to the license server (redirects, time limit, size limit, status codes)
 * and the OpenAPI entries.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import {
  currentLicenseUrl,
  DEFAULT_LICENSE_SERVER_URL,
  isLicenseAutoUpdateDisabledByEnv,
  resolveLicenseServer,
} from '@/ee/licensing/auto-update-env';
import {
  fetchCurrentLicenseKey,
  LICENSE_SERVER_TIMEOUT_MS,
  MAX_LICENSE_RESPONSE_BYTES,
} from '@/ee/licensing/auto-update-transport';
import { isRefreshToken, parseLicenseAutoUpdateInput, REFRESH_TOKEN_PATTERN } from '@/ee/licensing/auto-update';
import { ApiValidationError } from '@/src/lib/api-errors';
import { GET as getOpenApi } from '@/app/api/v1/openapi.json/route';

const TOKEN = `lrt_${'A1b2_-'.repeat(7)}x`;
const URL_ = 'https://license.example.com/v1/licenses/LIC-TEST/current';

function respond(status: number, body: BodyInit | null = null, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(body, { status, headers }));
}

describe('environment', () => {
  it('reads LICENSE_AUTO_UPDATE_DISABLED so a typo errs on the side of not calling out', () => {
    expect(isLicenseAutoUpdateDisabledByEnv({})).toBe(false);
    for (const off of ['', 'false', '0', 'no', 'off', ' OFF ']) {
      expect(isLicenseAutoUpdateDisabledByEnv({ LICENSE_AUTO_UPDATE_DISABLED: off }), off).toBe(false);
    }
    for (const on of ['true', '1', 'yes', 'ture', 'disabled']) {
      expect(isLicenseAutoUpdateDisabledByEnv({ LICENSE_AUTO_UPDATE_DISABLED: on }), on).toBe(true);
    }
  });

  it('uses license.ingres.si unless LICENSE_SERVER_URL names another https server', () => {
    expect(resolveLicenseServer({})).toEqual({ url: DEFAULT_LICENSE_SERVER_URL, error: null });
    expect(DEFAULT_LICENSE_SERVER_URL).toBe('https://license.ingres.si');
    expect(resolveLicenseServer({ LICENSE_SERVER_URL: ' ' })).toEqual({ url: DEFAULT_LICENSE_SERVER_URL, error: null });
    expect(resolveLicenseServer({ LICENSE_SERVER_URL: 'https://license.example.com/' })).toEqual({ url: 'https://license.example.com', error: null });
    expect(resolveLicenseServer({ LICENSE_SERVER_URL: 'https://example.com/licensing/' })).toEqual({ url: 'https://example.com/licensing', error: null });
  });

  it('never falls back to the default for an invalid LICENSE_SERVER_URL', () => {
    const cases: Array<[string, RegExp]> = [
      ['http://license.example.com', /https/],
      ['license.example.com', /not a valid URL/],
      ['https://user:secret@license.example.com', /credentials/],
      ['https://license.example.com/?x=1', /query or a fragment/],
      ['https://license.example.com/#x', /query or a fragment/],
      ['https://license.example.com/?', /query or a fragment/],
    ];
    for (const [value, error] of cases) {
      const result = resolveLicenseServer({ LICENSE_SERVER_URL: value });
      expect(result.url, value).toBeNull();
      expect(result.error, value).toMatch(error);
    }
  });

  it('puts the license id in the path, encoded', () => {
    expect(currentLicenseUrl('https://license.example.com', 'LIC-ABC')).toBe('https://license.example.com/v1/licenses/LIC-ABC/current');
    expect(currentLicenseUrl('https://license.example.com', 'a/b?c')).toBe('https://license.example.com/v1/licenses/a%2Fb%3Fc/current');
  });
});

describe('refresh token and body validation', () => {
  it('accepts exactly lrt_ and 43 base64url characters', () => {
    expect(TOKEN).toMatch(REFRESH_TOKEN_PATTERN);
    expect(isRefreshToken(TOKEN)).toBe(true);
    for (const bad of [TOKEN.slice(0, -1), `${TOKEN}A`, TOKEN.replace('lrt_', 'lrx_'), TOKEN.replace('A', '+'), ` ${TOKEN}`, '', null, 42]) {
      expect(isRefreshToken(bad), String(bad)).toBe(false);
    }
  });

  it('takes exactly { enabled, refreshToken? }', () => {
    expect(parseLicenseAutoUpdateInput({ enabled: false })).toEqual({ enabled: false });
    expect(parseLicenseAutoUpdateInput({ enabled: true })).toEqual({ enabled: true });
    expect(parseLicenseAutoUpdateInput({ enabled: true, refreshToken: ` ${TOKEN} ` })).toEqual({ enabled: true, refreshToken: TOKEN });
    expect(parseLicenseAutoUpdateInput({ enabled: true, refreshToken: '' })).toEqual({ enabled: true });
    const refused: unknown[] = [
      null,
      [],
      'on',
      {},
      { enabled: 'true' },
      { enabled: true, extra: 1 },
      { enabled: true, refreshToken: 'lrt_short' },
      { enabled: true, refreshToken: 42 },
      { enabled: false, refreshToken: TOKEN },
    ];
    for (const body of refused) {
      expect(() => parseLicenseAutoUpdateInput(body), JSON.stringify(body)).toThrow(ApiValidationError);
    }
  });

  it('never echoes the refused token in the error', () => {
    const almost = `${TOKEN}Z`;
    try {
      parseLicenseAutoUpdateInput({ enabled: true, refreshToken: almost });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(almost);
    }
  });
});

describe('fetchCurrentLicenseKey', () => {
  it('sends one GET with the bearer token, no redirects, no cookies and a time limit', async () => {
    const fetchMock = respond(200, JSON.stringify({ licenseId: 'LIC-TEST', key: 'v1.a.b', issuedAt: '2026-10-01T00:00:00Z', expiresAt: '2027-10-01T00:00:00Z' }));
    expect(await fetchCurrentLicenseKey(URL_, TOKEN, fetchMock as never)).toEqual({ kind: 'ok', key: 'v1.a.b' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    expect(init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, accept: 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
  });

  it('maps 401 and 403 to unauthorized, 410 to revoked', async () => {
    expect(await fetchCurrentLicenseKey(URL_, TOKEN, respond(401) as never)).toEqual({ kind: 'unauthorized' });
    expect(await fetchCurrentLicenseKey(URL_, TOKEN, respond(403) as never)).toEqual({ kind: 'unauthorized' });
    expect(await fetchCurrentLicenseKey(URL_, TOKEN, respond(410, '{"error":"revoked"}') as never)).toEqual({ kind: 'revoked' });
  });

  it('reports other answers in its own words, never the response body', async () => {
    const secretish = 'internal stack trace with details';
    const cases: Array<[unknown, RegExp]> = [
      [respond(302, null, { location: 'https://evil.example.com/' }), /redirect/],
      [vi.fn(async () => ({ type: 'opaqueredirect', status: 0, headers: new Headers(), body: null }) as unknown as Response), /redirect/],
      [respond(429), /429/],
      [respond(500, secretish), /HTTP 500/],
      [respond(200, `not json ${secretish}`), /not JSON/],
      [respond(200, JSON.stringify({ licenseId: 'LIC-TEST' })), /no license key/],
      [respond(200, JSON.stringify({ key: 42 })), /no license key/],
      [respond(200, JSON.stringify([{ key: 'v1.a.b' }])), /no license key/],
      [vi.fn(async () => { throw new TypeError('fetch failed'); }), /could not be reached/],
      [vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }), new RegExp(`${LICENSE_SERVER_TIMEOUT_MS / 1000} seconds`)],
    ];
    for (const [fetchMock, error] of cases) {
      const result = await fetchCurrentLicenseKey(URL_, TOKEN, fetchMock as never);
      expect(result.kind).toBe('error');
      const message = (result as { error: string }).error;
      expect(message).toMatch(error);
      expect(message).not.toContain(secretish);
      expect(message).not.toContain(TOKEN);
    }
  });

  it('stops reading an answer larger than 16 KiB, whatever Content-Length says', async () => {
    expect(MAX_LICENSE_RESPONSE_BYTES).toBe(16 * 1024);
    const big = JSON.stringify({ key: `v1.${'a'.repeat(MAX_LICENSE_RESPONSE_BYTES)}.b` });
    const declared = respond(200, big, { 'content-length': String(big.length) });
    expect(await fetchCurrentLicenseKey(URL_, TOKEN, declared as never)).toEqual({ kind: 'error', error: "the license server's answer is too large" });

    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(4096).fill(97));
        if (pulled > 100) controller.close();
      },
    });
    const undeclared = vi.fn(async () => new Response(stream, { status: 200 }));
    expect(await fetchCurrentLicenseKey(URL_, TOKEN, undeclared as never)).toEqual({ kind: 'error', error: "the license server's answer is too large" });
    expect(pulled).toBeLessThan(10);
  });
});

describe('OpenAPI', () => {
  it('documents the endpoints under License with their permissions, and never the token as readable', async () => {
    const doc = await (await getOpenApi({ headers: { get: () => null } } as never)).json();
    const expected: Record<string, string[]> = {
      '/api/v1/license/auto-update': ['get', 'put'],
      '/api/v1/license/auto-update/check': ['post'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(doc.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(doc.paths[path][method].tags).toEqual(['License']);
        expect(doc.paths[path][method].description).toMatch(/license:(read|write)/);
      }
    }
    const view = doc.components.schemas.LicenseAutoUpdate;
    expect(Object.keys(view.properties)).not.toContain('refreshToken');
    expect(view.properties.hasRefreshToken.type).toBe('boolean');
    const input = doc.components.schemas.LicenseAutoUpdateInput;
    expect(input.additionalProperties).toBe(false);
    expect(input.properties.refreshToken.writeOnly).toBe(true);

    const documented = JSON.stringify([...Object.keys(expected).map((path) => doc.paths[path]), view, input]);
    for (const ref of new Set(documented.match(/"\$ref":"#\/components\/[^"]+"/g) ?? [])) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], doc), ref).toBeDefined();
    }
  });
});
