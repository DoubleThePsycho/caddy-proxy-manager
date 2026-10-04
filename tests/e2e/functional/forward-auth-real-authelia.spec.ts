/**
 * Functional tests: Generic Forward Auth against REAL Authelia.
 *
 * Unlike forward-auth-generic.spec.ts (which uses a mock forward-auth server
 * that mimics Authelia's contract), these tests exercise the actual Authelia
 * v4.38 authz endpoint (/api/authz/forward-auth) running in the test stack:
 *
 *  - Real session issuance via the first-factor API (argon2id file backend).
 *  - Real browser-vs-API negotiation on the auth server (302 vs 401).
 *  - Real Remote-* identity headers copied onto the upstream request.
 *  - Real 401 for unauthenticated requests and WebSocket handshakes.
 *  - The authenticated WebSocket upgrade path through the forward-auth layer
 *    (valid session → auth 200 → 101 Switching Protocols), which the mock
 *    suite does not cover.
 *
 * Authelia only accepts https/wss target schemes, so the protected hosts are
 * served over TLS with a self-signed certificate imported into Ingressi, matching
 * real deployments.
 *
 * Domain: app.auth.test (Authelia portal: auth.test, localhost:9092).
 */
import { test, expect } from '@playwright/test';
import { httpsGet, wssHandshakeTls } from '../../helpers/https';
import { createSelfSignedServerCertificate } from '../../helpers/certs';
import { autheliaFirstFactor } from '../../helpers/authelia';

const DOMAIN = 'app.auth.test';
const PORTAL_URL_PREFIX = 'https://auth.test';
const API = 'http://localhost:3000/api/v1';
const ORIGIN = 'http://localhost:3000';
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const APP_USERNAME = 'e2euser';
const APP_PASSWORD = 'TestPassword2026!';

let hostId: number;
let sessionCookie: string;

test.describe.serial('Generic Forward Auth — Real Authelia', () => {
  test('setup: TLS certificate, proxy host, and Authelia session', async ({ page }) => {
    // Import a self-signed TLS certificate for the protected host.
    const serverCert = createSelfSignedServerCertificate(DOMAIN, [DOMAIN]);
    const certRes = await page.request.post(`${API}/certificates`, {
      data: {
        name: 'Real Authelia Test Cert',
        type: 'imported',
        domainNames: [DOMAIN],
        autoRenew: false,
        certificatePem: serverCert.certificatePem,
        privateKeyPem: serverCert.privateKeyPem,
      },
      headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN },
    });
    expect(certRes.status()).toBe(201);
    const cert = await certRes.json();

    const res = await page.request.post(`${API}/proxy-hosts`, {
      data: {
        name: 'Real Authelia Host',
        domains: [DOMAIN],
        upstreams: ['whoami-server:80'],
        sslForced: true,
        certificateId: cert.id,
        forwardAuth: {
          enabled: true,
          provider: 'authelia',
          authUpstream: 'http://authelia:9091',
          authEndpoint: '/api/authz/forward-auth',
          apiSplit: true,
          apiBypassHeaders: ['X-Api-Key'],
          excludedPaths: ['/public/*'],
        },
      },
      headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN },
    });
    expect(res.status()).toBe(201);
    const host = await res.json();
    hostId = host.id;

    // Real Authelia answers unauthenticated API-shaped requests with 401.
    const deadline = Date.now() + 30_000;
    let last = 0;
    while (Date.now() < deadline) {
      try {
        const probe = await httpsGet(DOMAIN, '/api/status');
        last = probe.status;
        if (probe.status === 401) break;
      } catch { /* TLS route not ready */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(last).toBe(401);

    // Authenticate against the real Authelia first-factor API.
    const login = await autheliaFirstFactor(APP_USERNAME, APP_PASSWORD);
    expect(login.status).toBe(200);
    expect(login.body).toContain('OK');
    expect(login.sessionCookie).toBeTruthy();
    sessionCookie = login.sessionCookie!;
  });

  test('unauthenticated browser request gets a real Authelia portal redirect', async () => {
    const res = await httpsGet(DOMAIN, '/dashboard', {}, { Accept: BROWSER_ACCEPT });
    expect(res.status).toBe(302);
    const location = String(res.headers['location']);
    expect(location).toContain(PORTAL_URL_PREFIX);
    expect(location).toContain('rd=');
  });

  test('unauthenticated API request gets a real Authelia 401', async () => {
    const res = await httpsGet(DOMAIN, '/api/status');
    // Real Authelia negotiates at the STATUS level: API-shaped requests get a
    // 401 (browsers get a 302). Authelia also includes a Location header with
    // the portal URL on the 401 — informational for capable clients — so only
    // the status code is asserted here.
    expect(res.status).toBe(401);
  });

  test('X-Requested-With requests are treated as API clients (401)', async () => {
    const res = await httpsGet(DOMAIN, '/api/status', {}, {
      Accept: BROWSER_ACCEPT,
      'X-Requested-With': 'XMLHttpRequest',
    });
    expect(res.status).toBe(401);
  });

  test('curl-style Accept: */* clients get 401 via the apiSplit 3xx→401 conversion', async () => {
    // Real Authelia treats a leading Accept: */* as browser-like and responds
    // with a 302 portal redirect (verified against v4.38.19 source:
    // AcceptsMIME counts a first-entry wildcard as accepting text/html).
    // The Ingressi API branch converts that 302 into a bare 401 so machine clients
    // never receive the redirect — this test only passes when the conversion
    // actually fired against the real IdP's 302.
    const res = await httpsGet(DOMAIN, '/api/status', {}, { Accept: '*/*' });
    expect(res.status).toBe(401);
    expect(res.body).toBe('Unauthorized');
    expect(res.headers['location']).toBeUndefined();
  });

  test('authenticated request carries real Authelia identity headers to the upstream', async () => {
    const res = await httpsGet(DOMAIN, '/protected', {}, { Cookie: `authelia_session=${sessionCookie}` });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Remote-User: e2euser');
    expect(res.body).toContain('Remote-Email: e2euser@example.com');
  });

  test('authenticated WebSocket handshake upgrades through the forward-auth layer', async () => {
    const ws = await wssHandshakeTls(DOMAIN, '/echo', { Cookie: `authelia_session=${sessionCookie}` });
    expect(ws.statusCode).toBe(101);
    expect(ws.headers['upgrade']).toBe('websocket');
  });

  test('unauthenticated WebSocket handshake gets 401', async () => {
    const ws = await wssHandshakeTls(DOMAIN, '/echo');
    expect(ws.statusCode).toBe(401);
  });

  test('X-Api-Key request bypasses forward auth and reaches the upstream', async () => {
    const res = await httpsGet(DOMAIN, '/api/machine', {}, { 'X-Api-Key': 'upstream-managed-key' });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Hostname:');
  });

  test('spoofed Remote-User is stripped on the bypassed route', async () => {
    const res = await httpsGet(DOMAIN, '/api/machine', {}, {
      'X-Api-Key': 'upstream-managed-key',
      'Remote-User': 'e2euser',
      'Remote-Groups': 'admins',
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('Remote-User');
    expect(res.body).not.toContain('Remote-Groups');
  });

  test('spoofed Remote-User is stripped on the excluded route', async () => {
    const res = await httpsGet(DOMAIN, '/public/asset', {}, { 'Remote-User': 'e2euser' });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('Remote-User');
  });

  test('cleanup: delete proxy host', async ({ page }) => {
    if (hostId) {
      const res = await page.request.delete(`${API}/proxy-hosts/${hostId}`, {
        headers: { 'Origin': ORIGIN },
      });
      expect(res.status()).toBe(200);
    }
  });
});
